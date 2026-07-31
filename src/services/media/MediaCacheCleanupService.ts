import type { MediaObjectData } from '@/models/MediaObject';
import type { MediaChunkRepository } from '@/repositories/MediaChunkRepository';
import type { MediaObjectRepository } from '@/repositories/MediaObjectRepository';
import type { PostRepository } from '@/repositories/PostRepository';
import type { PeerId } from '@/network/NetworkTypes';

import type { MediaDownloadRepository } from './MediaDownloadRepository';
import { MediaIntegrityService } from './MediaIntegrityService';

const DEFAULT_RECENT_ACCESS_PROTECTION_MS = 24 * 60 * 60 * 1000;

export interface MediaCacheCleanupOptions {
  maxBytes?: number;
  postScanBatchSize?: number;
  mediaScanBatchSize?: number;
  localPeerId?: PeerId;
  downloadRepository?: Pick<
    MediaDownloadRepository,
    | 'findCompleteReplicaPeers'
    | 'getMediaAccess'
    | 'getState'
    | 'pruneExpiredAnnouncements'
    | 'removeMediaAccess'
  >;
  recentAccessProtectionMs?: number;
  now?: () => number;
}

export interface MediaCacheCleanupResult {
  protectedMediaObjects: number;
  deletedMediaObjects: number;
  deletedChunks: number;
  freedBytes: number;
  remainingBytes: number;
  expiredAnnouncementsRemoved: number;
  protectedByActiveDownload: number;
  protectedByRecentAccess: number;
  protectedAsLastKnownReplica: number;
}

interface RetentionFacts {
  referenced: boolean;
  externallyAvailableReplicas: number;
  lastAccessedAt: number;
  size: number;
}

export class MediaCacheCleanupService {
  private readonly integrityService = new MediaIntegrityService();

  constructor(
    private readonly postRepository: Pick<PostRepository, 'getAll'>,
    private readonly mediaObjectRepository: Pick<MediaObjectRepository, 'getAll' | 'delete'>,
    private readonly mediaChunkRepository: Pick<
      MediaChunkRepository,
      'getAll' | 'getByMediaObjectId' | 'delete' | 'deleteByMediaObjectId' | 'getTotalStorageSize'
    >,
    private readonly options: MediaCacheCleanupOptions = {},
  ) {}

  async cleanup(): Promise<MediaCacheCleanupResult> {
    const now = this.options.now?.() ?? Date.now();
    const expiredAnnouncementsRemoved =
      (await this.options.downloadRepository?.pruneExpiredAnnouncements(now)) ?? 0;
    const referencedMediaIds = await this.collectReferencedMediaIds();
    const allMediaObjects = await this.listAllMediaObjects();
    const existingMediaObjects = new Map(
      allMediaObjects.map((mediaObject) => [mediaObject.id, mediaObject]),
    );
    const retention = this.evaluateRetention(allMediaObjects, referencedMediaIds, now);
    const protectedMediaIds = retention.protectedMediaIds;
    let deletedMediaObjects = 0;
    let deletedChunks = 0;
    let freedBytes = 0;

    for (const mediaObject of this.sortEvictionCandidates(allMediaObjects, retention.facts)) {
      const facts = retention.facts.get(mediaObject.id);
      if (protectedMediaIds.has(mediaObject.id) || facts?.referenced) {
        continue;
      }
      const chunks = await this.mediaChunkRepository.getByMediaObjectId(mediaObject.id);
      freedBytes += chunks.reduce((sum, chunk) => sum + chunk.size, 0);
      deletedChunks += chunks.length;
      await this.mediaChunkRepository.deleteByMediaObjectId(mediaObject.id);
      await this.mediaObjectRepository.delete(mediaObject.id);
      await this.options.downloadRepository?.removeMediaAccess(mediaObject.id);
      existingMediaObjects.delete(mediaObject.id);
      deletedMediaObjects += 1;
    }

    const orphanResult = await this.deleteInvalidOrOrphanChunks(existingMediaObjects);
    deletedChunks += orphanResult.deletedChunks;
    freedBytes += orphanResult.freedBytes;

    const limitResult = await this.enforceStorageLimit(protectedMediaIds, retention.facts);
    deletedMediaObjects += limitResult.deletedMediaObjects;
    deletedChunks += limitResult.deletedChunks;
    freedBytes += limitResult.freedBytes;

    return {
      protectedMediaObjects: protectedMediaIds.size,
      deletedMediaObjects,
      deletedChunks,
      freedBytes,
      remainingBytes: await this.mediaChunkRepository.getTotalStorageSize(),
      expiredAnnouncementsRemoved,
      protectedByActiveDownload: retention.protectedByActiveDownload,
      protectedByRecentAccess: retention.protectedByRecentAccess,
      protectedAsLastKnownReplica: retention.protectedAsLastKnownReplica,
    };
  }

  private async collectReferencedMediaIds(): Promise<Set<string>> {
    const referencedIds = new Set<string>();
    const batchSize = this.options.postScanBatchSize ?? 100;
    let offset = 0;

    while (true) {
      const posts = await this.postRepository.getAll(batchSize, offset);
      for (const post of posts) {
        for (const attachment of post.mediaAttachments ?? []) {
          referencedIds.add(attachment.id);
        }
      }
      if (posts.length < batchSize) {
        break;
      }
      offset += batchSize;
    }

    return referencedIds;
  }

  private evaluateRetention(
    mediaObjects: readonly MediaObjectData[],
    referencedMediaIds: ReadonlySet<string>,
    now: number,
  ): {
    protectedMediaIds: Set<string>;
    facts: Map<string, RetentionFacts>;
    protectedByActiveDownload: number;
    protectedByRecentAccess: number;
    protectedAsLastKnownReplica: number;
  } {
    const protectedMediaIds = new Set<string>();
    const facts = new Map<string, RetentionFacts>();
    let protectedByActiveDownload = 0;
    let protectedByRecentAccess = 0;
    let protectedAsLastKnownReplica = 0;
    const recentAccessThreshold =
      now - (this.options.recentAccessProtectionMs ?? DEFAULT_RECENT_ACCESS_PROTECTION_MS);

    for (const mediaObject of mediaObjects) {
      const access = this.options.downloadRepository?.getMediaAccess(mediaObject.id);
      const download = this.options.downloadRepository?.getState(mediaObject.id);
      const activeDownload = download?.status === 'queued' || download?.status === 'downloading';
      const recentlyAccessed = Boolean(access && access.lastAccessedAt >= recentAccessThreshold);
      const referenced = referencedMediaIds.has(mediaObject.id);
      const externallyAvailableReplicas =
        this.options.downloadRepository?.findCompleteReplicaPeers(
          mediaObject.id,
          mediaObject.chunks,
          now,
        ).length ?? 0;
      const localUpload =
        this.options.localPeerId !== undefined && mediaObject.author === this.options.localPeerId;
      const lastKnownReplica = referenced && externallyAvailableReplicas === 0;

      if (
        access?.protected ||
        localUpload ||
        activeDownload ||
        recentlyAccessed ||
        lastKnownReplica
      ) {
        protectedMediaIds.add(mediaObject.id);
      }
      if (activeDownload) {
        protectedByActiveDownload += 1;
      }
      if (recentlyAccessed) {
        protectedByRecentAccess += 1;
      }
      if (lastKnownReplica) {
        protectedAsLastKnownReplica += 1;
      }
      facts.set(mediaObject.id, {
        referenced,
        externallyAvailableReplicas,
        lastAccessedAt: access?.lastAccessedAt ?? mediaObject.updatedAt,
        size: mediaObject.size,
      });
    }

    return {
      protectedMediaIds,
      facts,
      protectedByActiveDownload,
      protectedByRecentAccess,
      protectedAsLastKnownReplica,
    };
  }

  private async listAllMediaObjects(): Promise<MediaObjectData[]> {
    const mediaObjects: MediaObjectData[] = [];
    const batchSize = this.options.mediaScanBatchSize ?? 100;
    let offset = 0;

    while (true) {
      const batch = await this.mediaObjectRepository.getAll(batchSize, offset);
      mediaObjects.push(...batch);
      if (batch.length < batchSize) {
        break;
      }
      offset += batchSize;
    }

    return mediaObjects;
  }

  private async deleteInvalidOrOrphanChunks(
    existingMediaObjects: ReadonlyMap<string, MediaObjectData>,
  ): Promise<{ deletedChunks: number; freedBytes: number }> {
    const chunks = await this.mediaChunkRepository.getAll();
    let deletedChunks = 0;
    let freedBytes = 0;

    for (const chunk of chunks) {
      const mediaObject = existingMediaObjects.get(chunk.mediaObjectId);
      const expectedPosition = mediaObject?.chunks.indexOf(chunk.id) ?? -1;
      const valid =
        mediaObject &&
        expectedPosition >= 0 &&
        this.integrityService.validateChunk(chunk, {
          mediaObjectId: mediaObject.id,
          chunkId: chunk.id,
          position: expectedPosition,
        }).valid;
      if (valid) {
        continue;
      }
      await this.mediaChunkRepository.delete(chunk.id);
      deletedChunks += 1;
      freedBytes += chunk.size;
    }

    return { deletedChunks, freedBytes };
  }

  private async enforceStorageLimit(
    protectedMediaIds: ReadonlySet<string>,
    retentionFacts: ReadonlyMap<string, RetentionFacts>,
  ): Promise<{ deletedMediaObjects: number; deletedChunks: number; freedBytes: number }> {
    const maxBytes = this.options.maxBytes;
    if (!maxBytes || maxBytes <= 0) {
      return { deletedMediaObjects: 0, deletedChunks: 0, freedBytes: 0 };
    }

    let remainingBytes = await this.mediaChunkRepository.getTotalStorageSize();
    let deletedMediaObjects = 0;
    let deletedChunks = 0;
    let freedBytes = 0;

    if (remainingBytes <= maxBytes) {
      return { deletedMediaObjects, deletedChunks, freedBytes };
    }

    const mediaObjects = this.sortEvictionCandidates(
      await this.listAllMediaObjects(),
      retentionFacts,
    );
    for (const mediaObject of mediaObjects) {
      if (remainingBytes <= maxBytes) {
        break;
      }
      if (protectedMediaIds.has(mediaObject.id)) {
        continue;
      }
      const chunks = await this.mediaChunkRepository.getByMediaObjectId(mediaObject.id);
      const mediaBytes = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
      await this.mediaChunkRepository.deleteByMediaObjectId(mediaObject.id);
      await this.mediaObjectRepository.delete(mediaObject.id);
      await this.options.downloadRepository?.removeMediaAccess(mediaObject.id);
      deletedMediaObjects += 1;
      deletedChunks += chunks.length;
      freedBytes += mediaBytes;
      remainingBytes -= mediaBytes;
    }

    return { deletedMediaObjects, deletedChunks, freedBytes };
  }

  private sortEvictionCandidates(
    mediaObjects: readonly MediaObjectData[],
    retentionFacts: ReadonlyMap<string, RetentionFacts>,
  ): MediaObjectData[] {
    return [...mediaObjects].sort((left, right) => {
      const leftFacts = retentionFacts.get(left.id);
      const rightFacts = retentionFacts.get(right.id);
      if (leftFacts && rightFacts) {
        if (leftFacts.referenced !== rightFacts.referenced) {
          return leftFacts.referenced ? 1 : -1;
        }
        if (leftFacts.externallyAvailableReplicas !== rightFacts.externallyAvailableReplicas) {
          return rightFacts.externallyAvailableReplicas - leftFacts.externallyAvailableReplicas;
        }
        if (leftFacts.lastAccessedAt !== rightFacts.lastAccessedAt) {
          return leftFacts.lastAccessedAt - rightFacts.lastAccessedAt;
        }
        if (leftFacts.size !== rightFacts.size) {
          return rightFacts.size - leftFacts.size;
        }
      }
      return left.updatedAt - right.updatedAt || left.createdAt - right.createdAt;
    });
  }
}
