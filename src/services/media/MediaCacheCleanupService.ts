import type { MediaObjectData } from '@/models/MediaObject';
import type { MediaChunkRepository } from '@/repositories/MediaChunkRepository';
import type { MediaObjectRepository } from '@/repositories/MediaObjectRepository';
import type { PostRepository } from '@/repositories/PostRepository';

export interface MediaCacheCleanupOptions {
  maxBytes?: number;
  postScanBatchSize?: number;
  mediaScanBatchSize?: number;
}

export interface MediaCacheCleanupResult {
  protectedMediaObjects: number;
  deletedMediaObjects: number;
  deletedChunks: number;
  freedBytes: number;
  remainingBytes: number;
}

export class MediaCacheCleanupService {
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
    const protectedMediaIds = await this.collectProtectedMediaIds();
    const allMediaObjects = await this.listAllMediaObjects();
    const existingMediaIds = new Set(allMediaObjects.map((mediaObject) => mediaObject.id));
    let deletedMediaObjects = 0;
    let deletedChunks = 0;
    let freedBytes = 0;

    for (const mediaObject of this.sortEvictionCandidates(allMediaObjects)) {
      if (protectedMediaIds.has(mediaObject.id)) {
        continue;
      }
      const chunks = await this.mediaChunkRepository.getByMediaObjectId(mediaObject.id);
      freedBytes += chunks.reduce((sum, chunk) => sum + chunk.size, 0);
      deletedChunks += chunks.length;
      await this.mediaChunkRepository.deleteByMediaObjectId(mediaObject.id);
      await this.mediaObjectRepository.delete(mediaObject.id);
      existingMediaIds.delete(mediaObject.id);
      deletedMediaObjects += 1;
    }

    const orphanResult = await this.deleteOrphanChunks(existingMediaIds);
    deletedChunks += orphanResult.deletedChunks;
    freedBytes += orphanResult.freedBytes;

    const limitResult = await this.enforceStorageLimit(protectedMediaIds);
    deletedMediaObjects += limitResult.deletedMediaObjects;
    deletedChunks += limitResult.deletedChunks;
    freedBytes += limitResult.freedBytes;

    return {
      protectedMediaObjects: protectedMediaIds.size,
      deletedMediaObjects,
      deletedChunks,
      freedBytes,
      remainingBytes: await this.mediaChunkRepository.getTotalStorageSize(),
    };
  }

  private async collectProtectedMediaIds(): Promise<Set<string>> {
    const protectedIds = new Set<string>();
    const batchSize = this.options.postScanBatchSize ?? 100;
    let offset = 0;

    while (true) {
      const posts = await this.postRepository.getAll(batchSize, offset);
      for (const post of posts) {
        for (const attachment of post.mediaAttachments ?? []) {
          protectedIds.add(attachment.id);
        }
      }
      if (posts.length < batchSize) {
        break;
      }
      offset += batchSize;
    }

    return protectedIds;
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

  private async deleteOrphanChunks(
    existingMediaIds: ReadonlySet<string>,
  ): Promise<{ deletedChunks: number; freedBytes: number }> {
    const chunks = await this.mediaChunkRepository.getAll();
    let deletedChunks = 0;
    let freedBytes = 0;

    for (const chunk of chunks) {
      if (existingMediaIds.has(chunk.mediaObjectId)) {
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

    const mediaObjects = this.sortEvictionCandidates(await this.listAllMediaObjects());
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
      deletedMediaObjects += 1;
      deletedChunks += chunks.length;
      freedBytes += mediaBytes;
      remainingBytes -= mediaBytes;
    }

    return { deletedMediaObjects, deletedChunks, freedBytes };
  }

  private sortEvictionCandidates(mediaObjects: MediaObjectData[]): MediaObjectData[] {
    return [...mediaObjects].sort(
      (left, right) => left.updatedAt - right.updatedAt || left.createdAt - right.createdAt,
    );
  }
}
