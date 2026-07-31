import type { MediaChunkData } from '@/models/MediaChunk';
import type { MediaObjectData } from '@/models/MediaObject';
import type { PostData, PostMediaAttachment } from '@/models/Post';
import {
  createNetworkMessage,
  estimateNetworkMessageBytes,
  MAX_NETWORK_MESSAGE_BYTES,
  type NetworkMessage,
} from '@/network/NetworkMessage';
import type { PeerConnection, PeerTransport } from '@/network/PeerTransport';
import type { PeerId } from '@/network/NetworkTypes';
import { createLogger, type Logger } from '@/observability/Logger';
import type { MediaChunkRepository } from '@/repositories/MediaChunkRepository';
import type { MediaObjectRepository } from '@/repositories/MediaObjectRepository';

import type { MediaAvailabilityManifest, MediaDownloadRepository } from './MediaDownloadRepository';
import {
  isMediaAvailabilityAnnouncementV2,
  type MediaAvailabilityAnnouncementV2,
  type MediaAvailabilityItem,
  type MediaQuarantineReason,
} from './MediaAvailability';
import type { MediaAvailabilityService } from './MediaAvailabilityService';
import {
  MediaIntegrityService,
  type MediaChunkExpectation,
  type MediaChunkIntegrityFailure,
  type MediaIntegrityDescriptor,
  type MediaIntegrityReport,
} from './MediaIntegrityService';
import { MediaSourceSelector } from './MediaSourceSelector';
import {
  calculateMaxRawPayloadBytes,
  defaultMediaTransferSchedulerPolicy,
  MediaTransferScheduler,
  toMediaTransferError,
  type MediaTransferSchedulerSnapshot,
} from './MediaTransferScheduler';

interface MediaChunkRequestPayload {
  version: 1;
  type: 'media.chunk.request';
  mediaObjectId: string;
  chunkId: string;
  position: number;
}

interface MediaChunkResponsePayload {
  version: 1;
  type: 'media.chunk.response';
  chunk: Omit<MediaChunkData, 'chunkData'> & {
    chunkDataBase64: string;
  };
}

interface MediaChunkPartPayload {
  version: 1;
  type: 'media.chunk.part';
  chunk: Omit<MediaChunkData, 'chunkData'>;
  partIndex: number;
  totalParts: number;
  dataBase64: string;
}

interface LegacyMediaAvailabilityPayload {
  version: 1;
  type: 'media.availability.announce';
  manifest: MediaAvailabilityManifest;
}

interface MediaAvailabilityPayloadV2 {
  version: 2;
  type: 'media.availability.announce';
  announcement: MediaAvailabilityAnnouncementV2;
}

interface MediaReplicaOfferPayload {
  version: 1;
  type: 'media.replica.offer';
  mediaObjectId: string;
  offeredAt: number;
  expiresAt: number;
}

export interface PeerMediaSyncResult {
  requested: number;
  received: number;
  skipped: number;
  failed: number;
}

export type MediaDownloadStatus =
  'idle' | 'queued' | 'downloading' | 'partial' | 'available' | 'failed' | 'cancelled';

export interface MediaDownloadState {
  mediaObjectId: string;
  status: MediaDownloadStatus;
  totalChunks: number;
  downloadedChunks: number;
  requestedChunks: number;
  failedChunks: number;
  candidatePeers: PeerId[];
  updatedAt: number;
  error?: string;
}

export interface PeerMediaSyncOptions {
  requestTimeoutMs?: number;
  maxAttemptsPerChunk?: number;
  maxConcurrentDownloads?: number;
  maxConcurrentChunks?: number;
  peerFailureBackoffMs?: number;
  maxPeerFailuresBeforeBackoff?: number;
  maxPendingPartMessages?: number;
  maxPendingPartsPerMessage?: number;
  maxPendingPartsPerPeer?: number;
  maxPendingPartsPerMedia?: number;
  maxPendingBytes?: number;
  maxPendingBytesPerPeer?: number;
  maxPendingBytesPerMedia?: number;
  pendingPartTtlMs?: number;
  corruptReplicaQuarantineMs?: number;
  maxFrameBytes?: number;
  maxQueuedFramesPerPeer?: number;
  maxQueuedBytesPerPeer?: number;
  maxQueuedObjectsPerPeer?: number;
  maxQueuedChunksPerPeer?: number;
  writableTimeoutMs?: number;
  maxLocalMediaBytes?: number;
  canAcceptReplicaOffer?: (peerId: PeerId) => boolean;
  onLocalAvailabilityAnnounced?: () => void;
}

export type MediaDownloadStateHandler = (state: MediaDownloadState) => void;

export interface MediaPeerTransferStats {
  peerId: PeerId;
  successes: number;
  failures: number;
  backoffUntil: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}

interface MediaDownloadQueueItem {
  mediaObject: MediaObjectData;
  preferredPeerId?: PeerId;
  priority: number;
  enqueuedAt: number;
}

interface PendingChunkParts {
  sourcePeerId: PeerId;
  chunk: Omit<MediaChunkData, 'chunkData'>;
  totalParts: number;
  parts: Map<number, Uint8Array>;
  receivedBytes: number;
  createdAt: number;
  updatedAt: number;
}

interface PendingChunkRequest {
  expectation: MediaChunkExpectation & { sourcePeerId: PeerId };
  resolve: (chunk: MediaChunkData | null) => void;
  timeout: ReturnType<typeof globalThis.setTimeout>;
}

interface MediaChunkPartsSendResult {
  sentParts: number;
  totalParts: number;
  complete: boolean;
}

export class PeerMediaSyncService {
  private static readonly REQUEST_TIMEOUT_MS = 10000;
  private static readonly MAX_ATTEMPTS_PER_CHUNK = 2;
  private static readonly PEER_FAILURE_BACKOFF_MS = 30000;
  private static readonly MAX_PEER_FAILURES_BEFORE_BACKOFF = 1;
  private static readonly MAX_PENDING_PART_MESSAGES = 32;
  private static readonly MAX_PENDING_PARTS_PER_MESSAGE = 256;
  private static readonly MAX_PENDING_PARTS_PER_PEER = 512;
  private static readonly MAX_PENDING_PARTS_PER_MEDIA = 1024;
  private static readonly MAX_PENDING_BYTES = 32 * 1024 * 1024;
  private static readonly MAX_PENDING_BYTES_PER_PEER = 8 * 1024 * 1024;
  private static readonly MAX_PENDING_BYTES_PER_MEDIA = 16 * 1024 * 1024;
  private static readonly CORRUPT_REPLICA_QUARANTINE_MS = 30 * 60 * 1000;
  private static readonly REPLICA_OFFER_TTL_MS = 2 * 60 * 1000;
  private static readonly DEFAULT_MAX_LOCAL_MEDIA_BYTES = 1024 * 1024 * 1024;
  private readonly logger: Logger;
  private unsubscribe: (() => void) | null = null;
  private readonly pending = new Map<string, PendingChunkRequest>();
  private readonly pendingParts = new Map<string, PendingChunkParts>();
  private readonly downloadStates = new Map<string, MediaDownloadState>();
  private readonly downloadQueue = new Map<string, MediaDownloadQueueItem>();
  private readonly activeDownloads = new Set<string>();
  private readonly stateHandlers = new Set<MediaDownloadStateHandler>();
  private readonly peerStats = new Map<PeerId, MediaPeerTransferStats>();
  private queueProcessing = false;
  private stateWriteQueue: Promise<void> = Promise.resolve();
  private requestSequence = 0;
  private started = false;
  private integrityBootstrap: Promise<void> | null = null;
  private availabilityBootstrap: Promise<void> | null = null;
  private readonly sourceSelector: MediaSourceSelector | null;
  private readonly transferScheduler: MediaTransferScheduler;

  constructor(
    private readonly localPeerId: PeerId,
    private readonly transport: PeerTransport,
    private readonly mediaObjectRepository: MediaObjectRepository,
    private readonly mediaChunkRepository: MediaChunkRepository,
    logger: Logger = createLogger('PeerMediaSyncService'),
    private readonly options: PeerMediaSyncOptions = {},
    private readonly downloadRepository?: MediaDownloadRepository,
    private readonly integrityService: MediaIntegrityService = new MediaIntegrityService(),
    private readonly availabilityService?: MediaAvailabilityService,
    sourceSelector?: MediaSourceSelector,
    transferScheduler?: MediaTransferScheduler,
  ) {
    this.logger = logger;
    this.sourceSelector =
      sourceSelector ?? (downloadRepository ? new MediaSourceSelector(downloadRepository) : null);
    this.transferScheduler =
      transferScheduler ??
      new MediaTransferScheduler({
        ...defaultMediaTransferSchedulerPolicy,
        maxFrameBytes: options.maxFrameBytes ?? defaultMediaTransferSchedulerPolicy.maxFrameBytes,
        maxQueuedFramesPerPeer:
          options.maxQueuedFramesPerPeer ??
          defaultMediaTransferSchedulerPolicy.maxQueuedFramesPerPeer,
        maxQueuedBytesPerPeer:
          options.maxQueuedBytesPerPeer ??
          defaultMediaTransferSchedulerPolicy.maxQueuedBytesPerPeer,
        maxQueuedObjectsPerPeer:
          options.maxQueuedObjectsPerPeer ??
          defaultMediaTransferSchedulerPolicy.maxQueuedObjectsPerPeer,
        maxQueuedChunksPerPeer:
          options.maxQueuedChunksPerPeer ??
          defaultMediaTransferSchedulerPolicy.maxQueuedChunksPerPeer,
        writableTimeoutMs:
          options.writableTimeoutMs ?? defaultMediaTransferSchedulerPolicy.writableTimeoutMs,
      });
  }

  start(): void {
    if (this.unsubscribe) {
      return;
    }
    this.transferScheduler.start();
    this.started = true;
    this.unsubscribe = this.transport.subscribe(async (message, connection) => {
      try {
        await this.handleMessage(message, connection);
      } catch (error) {
        this.logger.warn('media_message_rejected', {
          peerId: connection.peerId,
          messageType: message.messageType,
          error: error instanceof Error ? error.message : 'Unknown media protocol error',
        });
      }
    });
    this.restoreDownloadStates();
    this.integrityBootstrap = this.validatePersistedMedia();
    this.availabilityBootstrap = this.initializeAvailability(this.integrityBootstrap);
    void this.completeStartup(this.availabilityBootstrap);
  }

  stop(): void {
    this.started = false;
    this.transferScheduler.stop();
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const request of this.pending.values()) {
      globalThis.clearTimeout(request.timeout);
      request.resolve(null);
    }
    this.pending.clear();
    this.pendingParts.clear();
    this.downloadQueue.clear();
    this.activeDownloads.clear();
    this.queueProcessing = false;
  }

  private async initializeAvailability(integrityBootstrap: Promise<void>): Promise<void> {
    await integrityBootstrap;
    const availabilityInitialization = await this.availabilityService?.initialize();
    if (
      availabilityInitialization &&
      (availabilityInitialization.invalidAnnouncementsRemoved > 0 ||
        availabilityInitialization.expiredAnnouncementsRemoved > 0)
    ) {
      this.logger.info('media_availability_storage_cleaned', {
        invalidAnnouncementsRemoved: availabilityInitialization.invalidAnnouncementsRemoved,
        expiredAnnouncementsRemoved: availabilityInitialization.expiredAnnouncementsRemoved,
      });
    }
  }

  private async completeStartup(availabilityBootstrap: Promise<void>): Promise<void> {
    try {
      await availabilityBootstrap;
      if (!this.started) {
        return;
      }
      await this.downloadRepository?.pruneExpiredQuarantines();
      await this.announceLocalAvailability();
      if (!this.started) {
        return;
      }
      await this.resumePendingDownloads();
    } catch (error) {
      this.logger.error('media_startup_failed', error);
    }
  }

  private async waitForIntegrityBootstrap(): Promise<void> {
    await this.integrityBootstrap;
  }

  private async waitForAvailabilityBootstrap(): Promise<void> {
    await this.availabilityBootstrap;
  }

  private async validatePersistedMedia(): Promise<void> {
    const mediaObjectCount = await this.mediaObjectRepository.getCount();
    if (mediaObjectCount === 0) {
      return;
    }
    const mediaObjects = await this.mediaObjectRepository.getAll(mediaObjectCount, 0);

    for (const mediaObject of mediaObjects) {
      const storedChunks = await this.mediaChunkRepository.getByMediaObjectId(mediaObject.id);
      if (storedChunks.length === 0) {
        continue;
      }
      const report = await this.inspectAndRepairMedia(mediaObject, storedChunks);
      await this.updateDownloadState(mediaObject.id, {
        status: report.available
          ? 'available'
          : report.validChunks.length > 0
            ? 'partial'
            : 'failed',
        totalChunks: mediaObject.chunks.length,
        downloadedChunks: report.validChunks.length,
        failedChunks: report.invalidChunks.length,
        error: report.available
          ? undefined
          : report.complete
            ? 'Media failed final integrity validation'
            : 'Stored media contains missing or invalid chunks',
      });
    }
  }

  private async inspectAndRepairMedia(
    media: MediaIntegrityDescriptor,
    storedChunks?: readonly MediaChunkData[],
  ): Promise<MediaIntegrityReport> {
    const chunks = storedChunks ?? (await this.mediaChunkRepository.getByMediaObjectId(media.id));
    const report = this.integrityService.inspectMedia(media, chunks);
    const invalidChunkIds = new Set(
      report.invalidChunks.map((chunk) => chunk.chunkId).filter(Boolean),
    );
    for (const chunkId of invalidChunkIds) {
      await this.mediaChunkRepository.delete(chunkId);
    }
    if (invalidChunkIds.size > 0) {
      this.logger.warn('local_media_chunks_removed', {
        mediaObjectId: media.id,
        removedChunks: invalidChunkIds.size,
        reasons: Array.from(new Set(report.invalidChunks.map((chunk) => chunk.reason))).join(','),
      });
    }
    return report;
  }

  subscribeDownloadStates(handler: MediaDownloadStateHandler): () => void {
    this.stateHandlers.add(handler);
    for (const state of this.downloadStates.values()) {
      handler({ ...state, candidatePeers: [...state.candidatePeers] });
    }
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  getDownloadState(mediaObjectId: string): MediaDownloadState | null {
    const state =
      this.downloadStates.get(mediaObjectId) ?? this.downloadRepository?.getState(mediaObjectId);
    return state ? { ...state, candidatePeers: [...state.candidatePeers] } : null;
  }

  getPeerTransferStats(peerId: PeerId): MediaPeerTransferStats {
    return { ...this.getMutablePeerStats(peerId) };
  }

  getTransferSchedulerSnapshot(): MediaTransferSchedulerSnapshot {
    return this.transferScheduler.getSnapshot();
  }

  async retryMediaObject(mediaObjectId: string): Promise<PeerMediaSyncResult> {
    const mediaObject = await this.mediaObjectRepository.getById(mediaObjectId);
    if (!mediaObject) {
      const state = await this.updateDownloadState(mediaObjectId, {
        status: 'failed',
        totalChunks: 0,
        error: 'Media object not found',
      });
      return {
        requested: state.requestedChunks,
        received: 0,
        skipped: 0,
        failed: 0,
      };
    }
    return await this.ensureMediaObjectAvailable(mediaObject);
  }

  async announceLocalAvailability(): Promise<void> {
    await this.waitForAvailabilityBootstrap();
    if (!this.availabilityService) {
      return;
    }
    const items = await this.buildLocalAvailabilityItems();
    const announcements = await this.availabilityService.createAnnouncements(items);

    for (const peerId of this.transport.getConnectedPeers()) {
      const connection = this.transport.getConnection(peerId);
      if (!connection) {
        continue;
      }
      for (const announcement of announcements) {
        const payload = {
          version: 2,
          type: 'media.availability.announce',
          announcement,
        } satisfies MediaAvailabilityPayloadV2;
        const correlationId = `media_availability_${this.localPeerId}_${announcement.sequence}_${announcement.pageIndex}`;
        if (!this.fitsNetworkLimit('media.availability.announce', payload, correlationId)) {
          this.logger.warn('availability_announce_too_large', {
            peerId,
            sequence: announcement.sequence,
            pageIndex: announcement.pageIndex,
            items: announcement.items.length,
          });
          continue;
        }
        await this.safeSend(connection, 'media.availability.announce', payload, correlationId, {
          priority: -10,
        });
      }
    }
    this.options.onLocalAvailabilityAnnounced?.();
  }

  async offerReplica(peerId: PeerId, mediaObjectId: string): Promise<boolean> {
    const connection = this.transport.getConnection(peerId);
    if (!connection) {
      return false;
    }
    const now = Date.now();
    const payload: MediaReplicaOfferPayload = {
      version: 1,
      type: 'media.replica.offer',
      mediaObjectId,
      offeredAt: now,
      expiresAt: now + PeerMediaSyncService.REPLICA_OFFER_TTL_MS,
    };
    return await this.safeSend(
      connection,
      'media.replica.offer',
      payload,
      `media_replica_offer_${this.localPeerId}_${mediaObjectId}_${now}`,
      { mediaObjectId, priority: -20 },
    );
  }

  async enqueueMediaObject(
    mediaObjectId: string,
    options: { preferredPeerId?: PeerId; priority?: number } = {},
  ): Promise<MediaDownloadState> {
    const mediaObject = await this.mediaObjectRepository.getById(mediaObjectId);
    if (!mediaObject) {
      return await this.updateDownloadState(mediaObjectId, {
        status: 'failed',
        totalChunks: 0,
        error: 'Media object not found',
      });
    }

    return await this.enqueueMediaObjectData(mediaObject, options);
  }

  async enqueueMediaObjectData(
    mediaObject: MediaObjectData,
    options: { preferredPeerId?: PeerId; priority?: number } = {},
  ): Promise<MediaDownloadState> {
    const existing = this.getDownloadState(mediaObject.id);
    const alreadyScheduled =
      this.activeDownloads.has(mediaObject.id) || this.downloadQueue.has(mediaObject.id);
    if (
      existing?.status === 'available' ||
      (existing?.status === 'downloading' && alreadyScheduled)
    ) {
      return existing;
    }

    this.downloadQueue.set(mediaObject.id, {
      mediaObject,
      preferredPeerId: options.preferredPeerId,
      priority: options.priority ?? 0,
      enqueuedAt: Date.now(),
    });
    const state = await this.updateDownloadState(mediaObject.id, {
      status: 'queued',
      totalChunks: mediaObject.chunks.length,
      candidatePeers: this.getCandidatePeers(
        options.preferredPeerId,
        mediaObjectToAttachment(mediaObject),
      ),
      error: undefined,
    });
    void this.processDownloadQueue();
    return state;
  }

  async cancelMediaDownload(mediaObjectId: string): Promise<MediaDownloadState> {
    this.downloadQueue.delete(mediaObjectId);
    this.transferScheduler.cancelMedia(mediaObjectId);
    for (const [correlationId, request] of this.pending) {
      if (request.expectation.mediaObjectId === mediaObjectId) {
        this.finishPendingRequest(correlationId, null);
      }
    }
    return await this.updateDownloadState(mediaObjectId, {
      status: 'cancelled',
      error: 'Download cancelled',
    });
  }

  async ensureMediaObjectAvailable(
    mediaObject: MediaObjectData,
    preferredPeerId?: PeerId,
  ): Promise<PeerMediaSyncResult> {
    await this.waitForIntegrityBootstrap();
    const attachment = mediaObjectToAttachment(mediaObject);
    return await this.downloadAttachmentChunks(
      attachment,
      this.getCandidatePeers(preferredPeerId, attachment),
    );
  }

  async ensurePostMediaAvailable(
    post: PostData,
    sourcePeerId: PeerId,
  ): Promise<PeerMediaSyncResult> {
    await this.waitForIntegrityBootstrap();
    const attachments = post.mediaAttachments ?? [];
    const result: PeerMediaSyncResult = { requested: 0, received: 0, skipped: 0, failed: 0 };
    if (attachments.length === 0) {
      result.skipped = attachments.reduce(
        (count, attachment) => count + attachment.chunks.length,
        0,
      );
      return result;
    }

    for (const attachment of attachments) {
      await this.ensureMediaObject(post, attachment);
      const attachmentResult = await this.downloadAttachmentChunks(
        attachment,
        this.getCandidatePeers(sourcePeerId, attachment),
      );
      result.requested += attachmentResult.requested;
      result.received += attachmentResult.received;
      result.skipped += attachmentResult.skipped;
      result.failed += attachmentResult.failed;
    }

    return result;
  }

  private async downloadAttachmentChunks(
    attachment: PostMediaAttachment,
    candidatePeers: PeerId[],
  ): Promise<PeerMediaSyncResult> {
    const result: PeerMediaSyncResult = { requested: 0, received: 0, skipped: 0, failed: 0 };
    const localIntegrity = await this.inspectAndRepairMedia(attachment);
    const localChunkIds = new Set(localIntegrity.validChunks.map((chunk) => chunk.id));
    const alreadyComplete = localIntegrity.complete;
    const alreadyValid = localIntegrity.available;
    await this.updateDownloadState(attachment.id, {
      status: alreadyValid ? 'available' : 'downloading',
      totalChunks: attachment.chunks.length,
      downloadedChunks: localChunkIds.size,
      candidatePeers,
      error:
        alreadyComplete && !alreadyValid ? 'Media failed final integrity validation' : undefined,
    });

    if (alreadyComplete) {
      result.skipped = localChunkIds.size;
      if (!alreadyValid) {
        result.failed = 1;
        await this.updateDownloadState(attachment.id, {
          status: 'failed',
          failedChunks: 1,
          error: 'Media failed final integrity validation',
        });
      }
      return result;
    }

    if (candidatePeers.length === 0) {
      const missing = localIntegrity.missingChunkIds.length;
      result.skipped = localChunkIds.size;
      result.failed = missing;
      await this.updateDownloadState(attachment.id, {
        status: missing > 0 ? 'failed' : 'available',
        failedChunks: missing,
        error: missing > 0 ? 'No connected peers can serve this media' : undefined,
      });
      return result;
    }

    result.skipped = localChunkIds.size;
    const missingChunks = attachment.chunks
      .map((chunkId, position) => ({ chunkId, position }))
      .filter(({ chunkId }) => !localChunkIds.has(chunkId));

    await runWithConcurrency(
      missingChunks,
      this.options.maxConcurrentChunks ?? 3,
      async ({ chunkId, position }) => {
        if (this.getDownloadState(attachment.id)?.status === 'cancelled') {
          result.failed += 1;
          return;
        }

        result.requested += 1;
        const chunk = await this.requestChunkFromCandidates(
          candidatePeers,
          attachment,
          chunkId,
          position,
        );
        if (chunk) {
          result.received += 1;
          localChunkIds.add(chunk.id);
          await this.announceLocalAvailability();
          await this.updateDownloadState(attachment.id, {
            status: 'downloading',
            downloadedChunks: localChunkIds.size,
            requestedChunks: result.requested,
            failedChunks: result.failed,
          });
        } else {
          result.failed += 1;
          await this.updateDownloadState(attachment.id, {
            status: 'partial',
            requestedChunks: result.requested,
            failedChunks: result.failed,
            error: `Chunk ${position} is not available from connected peers`,
          });
        }
      },
    );

    if (this.getDownloadState(attachment.id)?.status === 'cancelled') {
      return result;
    }

    const finalIntegrity = await this.inspectAndRepairMedia(attachment);
    const complete = finalIntegrity.complete;
    const valid = finalIntegrity.available;
    if (complete && !valid) {
      result.failed += 1;
    }
    await this.updateDownloadState(attachment.id, {
      status: valid
        ? 'available'
        : complete
          ? 'failed'
          : result.received > 0
            ? 'partial'
            : 'failed',
      downloadedChunks: finalIntegrity.validChunks.length,
      requestedChunks: result.requested,
      failedChunks: result.failed,
      error:
        complete && !valid
          ? 'Media failed final integrity validation'
          : result.failed > 0
            ? 'Some chunks are still missing'
            : undefined,
    });
    return result;
  }

  private async handleMessage(message: NetworkMessage, connection: PeerConnection): Promise<void> {
    if (message.messageType === 'media.replica.offer' && isMediaReplicaOffer(message.payload)) {
      await this.handleReplicaOffer(message.payload, connection);
      return;
    }

    if (message.messageType === 'media.chunk.request' && isMediaChunkRequest(message.payload)) {
      await this.handleChunkRequest(message.payload, connection, message.correlationId);
      return;
    }

    if (message.messageType === 'media.chunk.response' && isMediaChunkResponse(message.payload)) {
      await this.handleChunkResponse(message.payload, connection.peerId, message.correlationId);
      return;
    }

    if (message.messageType === 'media.chunk.part' && isMediaChunkPart(message.payload)) {
      await this.handleChunkPart(message.payload, connection.peerId, message.correlationId);
      return;
    }

    if (
      message.messageType === 'media.availability.announce' &&
      isMediaAvailabilityV2(message.payload)
    ) {
      if (!this.availabilityService) {
        this.logger.warn('availability_v2_service_unavailable', {
          peerId: connection.peerId,
        });
        return;
      }
      const result = await this.availabilityService.acceptAnnouncement(
        message.payload.announcement,
        connection.peerId,
      );
      if (!result.accepted) {
        if (result.reason !== 'duplicate') {
          this.logger.warn('availability_announcement_rejected', {
            peerId: connection.peerId,
            reason: result.reason,
          });
        }
        return;
      }
      await this.resumeDownloadsForAvailability(
        result.announcement.peerId,
        result.announcement.items,
      );
      return;
    }

    if (
      message.messageType === 'media.availability.announce' &&
      isLegacyMediaAvailability(message.payload)
    ) {
      await this.downloadRepository?.saveManifest(message.payload.manifest);
      this.logger.warn('legacy_media_availability_ignored', {
        peerId: connection.peerId,
      });
    }
  }

  private async handleReplicaOffer(
    payload: MediaReplicaOfferPayload,
    connection: PeerConnection,
  ): Promise<void> {
    const now = Date.now();
    if (
      payload.expiresAt <= now ||
      payload.offeredAt > now + 60_000 ||
      payload.expiresAt - payload.offeredAt > PeerMediaSyncService.REPLICA_OFFER_TTL_MS
    ) {
      this.logger.warn('replica_offer_expired', {
        peerId: connection.peerId,
        mediaObjectId: payload.mediaObjectId,
      });
      return;
    }
    if (this.options.canAcceptReplicaOffer?.(connection.peerId) === false) {
      this.logger.warn('replica_offer_untrusted', {
        peerId: connection.peerId,
        mediaObjectId: payload.mediaObjectId,
      });
      return;
    }

    const mediaObject = await this.mediaObjectRepository.getById(payload.mediaObjectId);
    if (!mediaObject) {
      this.logger.info('replica_offer_metadata_missing', {
        peerId: connection.peerId,
        mediaObjectId: payload.mediaObjectId,
      });
      return;
    }
    const storedChunks = await this.mediaChunkRepository.getByMediaObjectId(mediaObject.id);
    const integrity = this.integrityService.inspectMedia(mediaObject, storedChunks);
    if (integrity.available) {
      await this.announceLocalAvailability();
      return;
    }

    const currentBytes = await this.mediaChunkRepository.getTotalStorageSize();
    const validBytes = integrity.validChunks.reduce((total, chunk) => total + chunk.size, 0);
    const requiredBytes = Math.max(0, mediaObject.size - validBytes);
    const maxLocalMediaBytes =
      this.options.maxLocalMediaBytes ?? PeerMediaSyncService.DEFAULT_MAX_LOCAL_MEDIA_BYTES;
    if (currentBytes + requiredBytes > maxLocalMediaBytes) {
      this.logger.warn('replica_offer_quota_exceeded', {
        peerId: connection.peerId,
        mediaObjectId: payload.mediaObjectId,
        requiredBytes,
        currentBytes,
        maxLocalMediaBytes,
      });
      return;
    }

    await this.enqueueMediaObjectData(mediaObject, {
      preferredPeerId: connection.peerId,
      priority: -20,
    });
    this.logger.info('replica_offer_accepted', {
      peerId: connection.peerId,
      mediaObjectId: payload.mediaObjectId,
      requiredBytes,
    });
  }

  private async handleChunkRequest(
    payload: MediaChunkRequestPayload,
    connection: PeerConnection,
    correlationId?: string,
  ): Promise<void> {
    const chunk =
      (await this.mediaChunkRepository.getById(payload.chunkId)) ??
      (await this.mediaChunkRepository.getByPosition(payload.mediaObjectId, payload.position));
    const mediaObject = await this.mediaObjectRepository.getById(payload.mediaObjectId);
    const expectedPosition = mediaObject?.chunks.indexOf(payload.chunkId);
    if (
      !chunk ||
      (mediaObject &&
        (expectedPosition === undefined ||
          expectedPosition < 0 ||
          expectedPosition !== payload.position)) ||
      chunk.mediaObjectId !== payload.mediaObjectId
    ) {
      this.logger.warn('chunk_request_missed', {
        peerId: connection.peerId,
        mediaObjectId: payload.mediaObjectId,
        chunkId: payload.chunkId,
      });
      return;
    }
    const validation = this.integrityService.validateChunk(chunk, {
      mediaObjectId: payload.mediaObjectId,
      chunkId: payload.chunkId,
      position: payload.position,
    });
    if (!validation.valid) {
      await this.mediaChunkRepository.delete(chunk.id);
      this.logger.warn('chunk_request_corrupt_local_chunk_removed', {
        peerId: connection.peerId,
        mediaObjectId: payload.mediaObjectId,
        chunkId: payload.chunkId,
        reason: validation.reason,
      });
      return;
    }

    const responsePayload = {
      version: 1,
      type: 'media.chunk.response',
      chunk: serializeChunk(validation.chunk),
    } satisfies MediaChunkResponsePayload;
    if (!this.fitsNetworkLimit('media.chunk.response', responsePayload, correlationId)) {
      const transfer = await this.sendChunkParts(validation.chunk, connection, correlationId);
      if (transfer.complete) {
        this.logger.info('chunk_response_split', {
          peerId: connection.peerId,
          mediaObjectId: responsePayload.chunk.mediaObjectId,
          chunkId: responsePayload.chunk.id,
          parts: transfer.sentParts,
          size: validation.chunk.size,
        });
        return;
      }
      this.logger.warn('chunk_response_incomplete', {
        peerId: connection.peerId,
        mediaObjectId: responsePayload.chunk.mediaObjectId,
        chunkId: responsePayload.chunk.id,
        size: validation.chunk.size,
        sentParts: transfer.sentParts,
        totalParts: transfer.totalParts,
      });
      return;
    }
    await this.safeSend(connection, 'media.chunk.response', responsePayload, correlationId, {
      mediaObjectId: responsePayload.chunk.mediaObjectId,
      chunkId: responsePayload.chunk.id,
    });
  }

  private async handleChunkResponse(
    payload: MediaChunkResponsePayload,
    sourcePeerId: PeerId,
    correlationId?: string,
  ): Promise<void> {
    const request = correlationId ? this.pending.get(correlationId) : undefined;
    if (!correlationId || !request || request.expectation.sourcePeerId !== sourcePeerId) {
      this.logger.warn('chunk_response_rejected', {
        mediaObjectId: payload.chunk.mediaObjectId,
        chunkId: payload.chunk.id,
        reason: 'unsolicited-or-wrong-peer',
      });
      return;
    }

    let chunk: MediaChunkData;
    try {
      chunk = deserializeChunk(payload.chunk);
    } catch {
      await this.quarantineCorruptReplica(
        sourcePeerId,
        request.expectation.mediaObjectId,
        request.expectation.chunkId,
        'invalid-base64',
      );
      this.finishPendingRequest(correlationId, null);
      this.logger.warn('chunk_response_rejected', {
        mediaObjectId: payload.chunk.mediaObjectId,
        chunkId: payload.chunk.id,
        reason: 'invalid-base64',
        failureKind: 'corrupt',
      });
      return;
    }

    const validation = this.integrityService.validateChunk(chunk, request.expectation);
    if (!validation.valid) {
      const quarantineReason = toMediaQuarantineReason(validation.reason);
      if (quarantineReason) {
        await this.quarantineCorruptReplica(
          sourcePeerId,
          request.expectation.mediaObjectId,
          request.expectation.chunkId,
          quarantineReason,
          readableChunkEvidenceHash(chunk),
        );
      }
      this.finishPendingRequest(correlationId, null);
      this.logger.warn('chunk_response_rejected', {
        mediaObjectId: chunk.mediaObjectId,
        chunkId: chunk.id,
        reason: validation.reason,
        failureKind: 'corrupt',
      });
      return;
    }

    const existing = await this.mediaChunkRepository.getById(validation.chunk.id);
    const existingValidation = existing
      ? this.integrityService.validateChunk(existing, request.expectation)
      : null;
    if (!existingValidation?.valid) {
      try {
        await this.mediaChunkRepository.create(validation.chunk);
      } catch (error) {
        const transferError = toMediaTransferError(error);
        this.finishPendingRequest(correlationId, null);
        this.logger.warn('chunk_storage_failed', {
          peerId: sourcePeerId,
          mediaObjectId: request.expectation.mediaObjectId,
          chunkId: request.expectation.chunkId,
          failureKind: transferError.kind,
        });
        return;
      }
    }
    this.finishPendingRequest(correlationId, validation.chunk);
  }

  private async handleChunkPart(
    payload: MediaChunkPartPayload,
    sourcePeerId: PeerId,
    correlationId?: string,
  ): Promise<void> {
    this.pruneExpiredPendingParts();
    const request = correlationId ? this.pending.get(correlationId) : undefined;
    const maxParts =
      this.options.maxPendingPartsPerMessage ?? PeerMediaSyncService.MAX_PENDING_PARTS_PER_MESSAGE;
    if (
      !correlationId ||
      !request ||
      request.expectation.sourcePeerId !== sourcePeerId ||
      !Number.isSafeInteger(payload.totalParts) ||
      payload.totalParts <= 0 ||
      payload.totalParts > maxParts ||
      !Number.isSafeInteger(payload.partIndex) ||
      payload.partIndex < 0 ||
      payload.partIndex >= payload.totalParts
    ) {
      this.logger.warn('chunk_part_rejected', {
        mediaObjectId: payload.chunk.mediaObjectId,
        chunkId: payload.chunk.id,
        reason: 'invalid-part-index',
      });
      return;
    }
    if (
      payload.chunk.id !== request.expectation.chunkId ||
      payload.chunk.mediaObjectId !== request.expectation.mediaObjectId ||
      payload.chunk.position !== request.expectation.position ||
      payload.chunk.size <= 0
    ) {
      await this.rejectPendingParts(
        correlationId,
        payload,
        sourcePeerId,
        'request-metadata-mismatch',
      );
      return;
    }

    const decodedPart = tryBase64ToBytes(payload.dataBase64);
    if (!decodedPart || decodedPart.length === 0) {
      await this.rejectPendingParts(correlationId, payload, sourcePeerId, 'invalid-base64');
      return;
    }

    const existing =
      this.pendingParts.get(correlationId) ??
      ({
        sourcePeerId,
        chunk: payload.chunk,
        totalParts: payload.totalParts,
        parts: new Map<number, Uint8Array>(),
        receivedBytes: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } satisfies PendingChunkParts);

    if (
      existing.sourcePeerId !== sourcePeerId ||
      existing.chunk.id !== payload.chunk.id ||
      existing.chunk.mediaObjectId !== payload.chunk.mediaObjectId ||
      existing.chunk.position !== payload.chunk.position ||
      existing.chunk.size !== payload.chunk.size ||
      existing.chunk.hash !== payload.chunk.hash ||
      existing.totalParts !== payload.totalParts
    ) {
      await this.rejectPendingParts(correlationId, payload, sourcePeerId, 'metadata-mismatch');
      return;
    }

    const previousPart = existing.parts.get(payload.partIndex);
    if (previousPart) {
      if (!bytesEqual(previousPart, decodedPart)) {
        await this.rejectPendingParts(
          correlationId,
          payload,
          sourcePeerId,
          'conflicting-duplicate-part',
        );
      }
      return;
    }

    const maxPendingMessages =
      this.options.maxPendingPartMessages ?? PeerMediaSyncService.MAX_PENDING_PART_MESSAGES;
    if (!this.pendingParts.has(correlationId) && this.pendingParts.size >= maxPendingMessages) {
      await this.rejectPendingParts(correlationId, payload, sourcePeerId, 'pending-message-limit');
      return;
    }
    const nextReceivedBytes = existing.receivedBytes + decodedPart.length;
    if (
      nextReceivedBytes > existing.chunk.size ||
      this.getPendingPartCountForPeer(sourcePeerId) + 1 >
        (this.options.maxPendingPartsPerPeer ?? PeerMediaSyncService.MAX_PENDING_PARTS_PER_PEER) ||
      this.getPendingPartCountForMedia(existing.chunk.mediaObjectId) + 1 >
        (this.options.maxPendingPartsPerMedia ??
          PeerMediaSyncService.MAX_PENDING_PARTS_PER_MEDIA) ||
      this.getTotalPendingBytes() + decodedPart.length >
        (this.options.maxPendingBytes ?? PeerMediaSyncService.MAX_PENDING_BYTES) ||
      this.getPendingBytesForPeer(sourcePeerId) + decodedPart.length >
        (this.options.maxPendingBytesPerPeer ?? PeerMediaSyncService.MAX_PENDING_BYTES_PER_PEER) ||
      this.getPendingBytesForMedia(existing.chunk.mediaObjectId) + decodedPart.length >
        (this.options.maxPendingBytesPerMedia ?? PeerMediaSyncService.MAX_PENDING_BYTES_PER_MEDIA)
    ) {
      await this.rejectPendingParts(correlationId, payload, sourcePeerId, 'pending-byte-limit');
      return;
    }

    existing.parts.set(payload.partIndex, decodedPart);
    existing.receivedBytes = nextReceivedBytes;
    existing.updatedAt = Date.now();
    this.pendingParts.set(correlationId, existing);
    if (existing.parts.size < existing.totalParts) {
      return;
    }

    const chunk = deserializeChunkFromParts(existing);
    this.pendingParts.delete(correlationId);
    await this.handleChunkResponse(
      {
        version: 1,
        type: 'media.chunk.response',
        chunk: {
          ...existing.chunk,
          chunkDataBase64: bytesToBase64(chunk.chunkData),
        },
      },
      existing.sourcePeerId,
      correlationId,
    );
  }

  private async sendChunkParts(
    chunk: MediaChunkData,
    connection: PeerConnection,
    correlationId?: string,
  ): Promise<MediaChunkPartsSendResult> {
    const maxFrameBytes = Math.min(
      this.options.maxFrameBytes ?? defaultMediaTransferSchedulerPolicy.maxFrameBytes,
      MAX_NETWORK_MESSAGE_BYTES,
    );
    const rawBytesPerPart = calculateMaxRawPayloadBytes({
      totalRawBytes: chunk.chunkData.length,
      maxFrameBytes,
      buildFrame: (rawBytes, totalParts) => {
        const payload = {
          version: 1,
          type: 'media.chunk.part',
          chunk: serializeChunkMetadata(chunk),
          partIndex: totalParts - 1,
          totalParts,
          dataBase64: bytesToBase64(chunk.chunkData.slice(0, rawBytes)),
        } satisfies MediaChunkPartPayload;
        return createNetworkMessage({
          messageType: 'media.chunk.part',
          senderId: this.localPeerId,
          payload,
          correlationId,
          ttlMs: 5 * 60 * 1000,
        });
      },
    });
    if (rawBytesPerPart <= 0) {
      return { sentParts: 0, totalParts: 0, complete: false };
    }
    const totalParts = Math.ceil(chunk.chunkData.length / rawBytesPerPart);
    const maxParts =
      this.options.maxPendingPartsPerMessage ?? PeerMediaSyncService.MAX_PENDING_PARTS_PER_MESSAGE;
    if (totalParts > maxParts) {
      return { sentParts: 0, totalParts, complete: false };
    }
    for (let partIndex = 0; partIndex < totalParts; partIndex += 1) {
      const start = partIndex * rawBytesPerPart;
      const end = Math.min(start + rawBytesPerPart, chunk.chunkData.length);
      const payload = {
        version: 1,
        type: 'media.chunk.part',
        chunk: serializeChunkMetadata(chunk),
        partIndex,
        totalParts,
        dataBase64: bytesToBase64(chunk.chunkData.slice(start, end)),
      } satisfies MediaChunkPartPayload;
      if (!this.fitsNetworkLimit('media.chunk.part', payload, correlationId)) {
        return { sentParts: partIndex, totalParts, complete: false };
      }
      const sent = await this.safeSend(connection, 'media.chunk.part', payload, correlationId, {
        mediaObjectId: chunk.mediaObjectId,
        chunkId: chunk.id,
      });
      if (!sent) {
        return { sentParts: partIndex, totalParts, complete: false };
      }
    }
    return { sentParts: totalParts, totalParts, complete: true };
  }

  private finishPendingRequest(correlationId: string, chunk: MediaChunkData | null): void {
    const request = this.pending.get(correlationId);
    if (!request) {
      this.pendingParts.delete(correlationId);
      return;
    }
    globalThis.clearTimeout(request.timeout);
    this.pending.delete(correlationId);
    this.pendingParts.delete(correlationId);
    request.resolve(chunk);
  }

  private async rejectPendingParts(
    correlationId: string,
    payload: MediaChunkPartPayload,
    sourcePeerId: PeerId,
    reason: string,
  ): Promise<void> {
    const quarantineReason = toPartQuarantineReason(reason);
    if (quarantineReason) {
      await this.quarantineCorruptReplica(
        sourcePeerId,
        payload.chunk.mediaObjectId,
        payload.chunk.id,
        quarantineReason,
      );
    }
    this.finishPendingRequest(correlationId, null);
    this.logger.warn('chunk_part_rejected', {
      mediaObjectId: payload.chunk.mediaObjectId,
      chunkId: payload.chunk.id,
      reason,
      failureKind:
        reason === 'pending-message-limit' || reason === 'pending-byte-limit'
          ? 'backpressure'
          : quarantineReason
            ? 'corrupt'
            : 'unavailable',
    });
  }

  private pruneExpiredPendingParts(now = Date.now()): void {
    const ttl =
      this.options.pendingPartTtlMs ??
      this.options.requestTimeoutMs ??
      PeerMediaSyncService.REQUEST_TIMEOUT_MS;
    for (const [correlationId, parts] of this.pendingParts) {
      if (parts.updatedAt + ttl > now) {
        continue;
      }
      this.finishPendingRequest(correlationId, null);
      this.logger.warn('chunk_parts_expired', {
        peerId: parts.sourcePeerId,
        mediaObjectId: parts.chunk.mediaObjectId,
        chunkId: parts.chunk.id,
        receivedParts: parts.parts.size,
        totalParts: parts.totalParts,
      });
    }
  }

  private getPendingBytesForPeer(peerId: PeerId): number {
    let total = 0;
    for (const parts of this.pendingParts.values()) {
      if (parts.sourcePeerId === peerId) {
        total += parts.receivedBytes;
      }
    }
    return total;
  }

  private getPendingBytesForMedia(mediaObjectId: string): number {
    let total = 0;
    for (const parts of this.pendingParts.values()) {
      if (parts.chunk.mediaObjectId === mediaObjectId) {
        total += parts.receivedBytes;
      }
    }
    return total;
  }

  private getTotalPendingBytes(): number {
    let total = 0;
    for (const parts of this.pendingParts.values()) {
      total += parts.receivedBytes;
    }
    return total;
  }

  private getPendingPartCountForPeer(peerId: PeerId): number {
    let total = 0;
    for (const parts of this.pendingParts.values()) {
      if (parts.sourcePeerId === peerId) {
        total += parts.parts.size;
      }
    }
    return total;
  }

  private getPendingPartCountForMedia(mediaObjectId: string): number {
    let total = 0;
    for (const parts of this.pendingParts.values()) {
      if (parts.chunk.mediaObjectId === mediaObjectId) {
        total += parts.parts.size;
      }
    }
    return total;
  }

  private async safeSend(
    connection: PeerConnection,
    messageType: NetworkMessage['messageType'],
    payload: unknown,
    correlationId?: string,
    context: {
      mediaObjectId?: string;
      chunkId?: string;
      priority?: number;
    } = {},
  ): Promise<boolean> {
    try {
      const ttlMs = 5 * 60 * 1000;
      const estimatedMessage = createNetworkMessage({
        messageType,
        senderId: this.localPeerId,
        payload,
        correlationId,
        ttlMs,
      });
      await this.transferScheduler.enqueue({
        connection,
        bytes: estimateNetworkMessageBytes(estimatedMessage),
        mediaObjectId: context.mediaObjectId,
        chunkId: context.chunkId,
        priority: context.priority,
        send: async () => {
          await connection.send(messageType, payload, {
            correlationId,
            ttlMs,
          });
        },
      });
      return true;
    } catch (error) {
      const transferError = toMediaTransferError(error, {
        connection,
        mediaObjectId: context.mediaObjectId,
        chunkId: context.chunkId,
      });
      if (transferError.kind === 'unavailable') {
        this.transferScheduler.cancelPeer(connection.peerId);
      }
      this.logger.warn('media_send_failed', {
        peerId: connection.peerId,
        messageType,
        failureKind: transferError.kind,
        error: transferError.message,
      });
      return false;
    }
  }

  private async requestChunk(
    peerId: PeerId,
    attachment: PostMediaAttachment,
    chunkId: string,
    position: number,
  ): Promise<MediaChunkData | null> {
    const correlationId = `media_request_${this.localPeerId}_${attachment.id}_${position}_${this.requestSequence++}`;
    const connection = this.transport.getConnection(peerId);
    if (!connection) {
      this.logger.info('chunk_request_skipped', {
        peerId,
        mediaObjectId: attachment.id,
        chunkId,
        failureKind: 'unavailable',
      });
      return null;
    }

    const responsePromise = new Promise<MediaChunkData | null>((resolve) => {
      const timeout = globalThis.setTimeout(() => {
        this.finishPendingRequest(correlationId, null);
        this.logger.warn('chunk_request_failed', {
          peerId,
          mediaObjectId: attachment.id,
          chunkId,
          failureKind: 'timeout',
        });
      }, this.options.requestTimeoutMs ?? PeerMediaSyncService.REQUEST_TIMEOUT_MS);
      this.pending.set(correlationId, {
        expectation: {
          sourcePeerId: peerId,
          mediaObjectId: attachment.id,
          chunkId,
          position,
        },
        resolve,
        timeout,
      });
    });
    const sent = await this.safeSend(
      connection,
      'media.chunk.request',
      {
        version: 1,
        type: 'media.chunk.request',
        mediaObjectId: attachment.id,
        chunkId,
        position,
      } satisfies MediaChunkRequestPayload,
      correlationId,
      {
        mediaObjectId: attachment.id,
        chunkId,
        priority: 10,
      },
    );
    if (!sent) {
      this.finishPendingRequest(correlationId, null);
      this.logger.warn('chunk_request_send_failed', {
        peerId,
        mediaObjectId: attachment.id,
        chunkId,
      });
      return null;
    }

    return await responsePromise;
  }

  private fitsNetworkLimit<TPayload>(
    messageType: NetworkMessage['messageType'],
    payload: TPayload,
    correlationId?: string,
  ): boolean {
    const message = createNetworkMessage({
      messageType,
      senderId: this.localPeerId,
      payload,
      correlationId,
      ttlMs: 5 * 60 * 1000,
    });
    return (
      estimateNetworkMessageBytes(message) <=
      Math.min(
        this.options.maxFrameBytes ?? defaultMediaTransferSchedulerPolicy.maxFrameBytes,
        MAX_NETWORK_MESSAGE_BYTES,
      )
    );
  }

  private async requestChunkFromCandidates(
    candidatePeers: readonly PeerId[],
    attachment: PostMediaAttachment,
    chunkId: string,
    position: number,
  ): Promise<MediaChunkData | null> {
    const maxAttempts =
      this.options.maxAttemptsPerChunk ?? PeerMediaSyncService.MAX_ATTEMPTS_PER_CHUNK;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const chunkAwareCandidates = this.getHealthyCandidatePeers(
        this.getChunkCandidatePeers(attachment, chunkId, candidatePeers),
      );
      for (const peerId of chunkAwareCandidates) {
        const startedAt = Date.now();
        const chunk = await this.requestChunk(peerId, attachment, chunkId, position);
        if (chunk) {
          this.recordPeerSuccess(peerId);
          await this.recordReplicaResultSafe({
            peerId,
            mediaObjectId: attachment.id,
            chunkId,
            status: 'success',
            latencyMs: Date.now() - startedAt,
          });
          return chunk;
        }
        this.recordPeerFailure(peerId);
        if (this.downloadRepository?.isReplicaQuarantined(peerId, attachment.id, chunkId)) {
          continue;
        }
        await this.recordReplicaResultSafe({
          peerId,
          mediaObjectId: attachment.id,
          chunkId,
          status: 'unavailable',
          latencyMs: Date.now() - startedAt,
        });
      }
    }
    return null;
  }

  private getCandidatePeers(preferredPeerId?: PeerId, attachment?: PostMediaAttachment): PeerId[] {
    const manifestPeers = attachment
      ? (this.downloadRepository?.findPeersForMedia(attachment.id) ?? [])
      : [];
    return Array.from(
      new Set([
        ...(preferredPeerId && this.transport.getConnection(preferredPeerId)
          ? [preferredPeerId]
          : []),
        ...manifestPeers,
        ...this.transport.getConnectedPeers(),
      ]),
    ).filter(
      (peerId) => peerId !== this.localPeerId && Boolean(this.transport.getConnection(peerId)),
    );
  }

  private getChunkCandidatePeers(
    attachment: PostMediaAttachment,
    chunkId: string,
    fallbackPeers: readonly PeerId[],
  ): PeerId[] {
    const connectedCandidates = Array.from(
      new Set([
        ...(this.downloadRepository?.findPeersForChunk(attachment.id, chunkId) ?? []),
        ...fallbackPeers,
      ]),
    ).filter((peerId) => Boolean(this.transport.getConnection(peerId)));
    return (
      this.sourceSelector?.select({
        mediaObjectId: attachment.id,
        chunkId,
        candidatePeers: connectedCandidates,
      }) ?? connectedCandidates
    );
  }

  private getHealthyCandidatePeers(candidatePeers: readonly PeerId[]): PeerId[] {
    const now = Date.now();
    const sorted = [...candidatePeers].sort((left, right) => {
      const leftStats = this.getMutablePeerStats(left);
      const rightStats = this.getMutablePeerStats(right);
      const leftScore = leftStats.successes - leftStats.failures;
      const rightScore = rightStats.successes - rightStats.failures;
      return rightScore - leftScore || String(left).localeCompare(String(right));
    });
    const healthy = sorted.filter((peerId) => this.getMutablePeerStats(peerId).backoffUntil <= now);
    return healthy.length > 0 ? healthy : sorted;
  }

  private recordPeerSuccess(peerId: PeerId): void {
    const stats = this.getMutablePeerStats(peerId);
    stats.successes += 1;
    stats.backoffUntil = 0;
    stats.lastSuccessAt = Date.now();
    this.peerStats.set(peerId, stats);
  }

  private recordPeerFailure(peerId: PeerId): void {
    const stats = this.getMutablePeerStats(peerId);
    const now = Date.now();
    stats.failures += 1;
    stats.lastFailureAt = now;
    const threshold =
      this.options.maxPeerFailuresBeforeBackoff ??
      PeerMediaSyncService.MAX_PEER_FAILURES_BEFORE_BACKOFF;
    if (stats.failures >= threshold) {
      stats.backoffUntil =
        now + (this.options.peerFailureBackoffMs ?? PeerMediaSyncService.PEER_FAILURE_BACKOFF_MS);
    }
    this.peerStats.set(peerId, stats);
  }

  private getMutablePeerStats(peerId: PeerId): MediaPeerTransferStats {
    return (
      this.peerStats.get(peerId) ?? {
        peerId,
        successes: 0,
        failures: 0,
        backoffUntil: 0,
      }
    );
  }

  private async recordReplicaResultSafe(
    input: Parameters<MediaDownloadRepository['recordReplicaResult']>[0],
  ): Promise<void> {
    try {
      await this.downloadRepository?.recordReplicaResult(input);
    } catch (error) {
      this.logger.warn('media_replica_observation_persist_failed', {
        peerId: input.peerId,
        mediaObjectId: input.mediaObjectId,
        chunkId: input.chunkId,
        status: input.status,
        error: error instanceof Error ? error.message : 'Unknown storage error',
      });
    }
  }

  private async quarantineCorruptReplica(
    peerId: PeerId,
    mediaObjectId: string,
    chunkId: string,
    reason: MediaQuarantineReason,
    evidenceHash?: string,
  ): Promise<void> {
    if (!this.downloadRepository) {
      return;
    }
    try {
      const record = await this.downloadRepository.quarantineReplica({
        peerId,
        mediaObjectId,
        chunkId,
        reason,
        evidenceHash,
        durationMs:
          this.options.corruptReplicaQuarantineMs ??
          PeerMediaSyncService.CORRUPT_REPLICA_QUARANTINE_MS,
      });
      await this.downloadRepository.recordReplicaResult({
        peerId,
        mediaObjectId,
        chunkId,
        status: 'corrupt',
      });
      this.logger.warn('media_replica_quarantined', {
        peerId,
        mediaObjectId,
        chunkId,
        reason,
        expiresAt: record.expiresAt,
        failureCount: record.failureCount,
      });
    } catch (error) {
      this.logger.warn('media_replica_quarantine_persist_failed', {
        peerId,
        mediaObjectId,
        chunkId,
        reason,
        error: error instanceof Error ? error.message : 'Unknown storage error',
      });
    }
  }

  private updateDownloadState(
    mediaObjectId: string,
    patch: Partial<Omit<MediaDownloadState, 'mediaObjectId' | 'updatedAt'>>,
  ): Promise<MediaDownloadState> {
    const operation = this.stateWriteQueue.then(async () => {
      const current =
        this.downloadStates.get(mediaObjectId) ??
        ({
          mediaObjectId,
          status: 'idle',
          totalChunks: 0,
          downloadedChunks: 0,
          requestedChunks: 0,
          failedChunks: 0,
          candidatePeers: [],
          updatedAt: Date.now(),
        } satisfies MediaDownloadState);
      const next = {
        ...current,
        ...patch,
        updatedAt: Date.now(),
      };
      await this.downloadRepository?.saveState(next);
      this.downloadStates.set(mediaObjectId, next);
      this.emitDownloadState(next);
      return next;
    });
    this.stateWriteQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async ensureMediaObject(post: PostData, attachment: PostMediaAttachment): Promise<void> {
    const existing = await this.mediaObjectRepository.getById(attachment.id);
    if (existing) {
      return;
    }
    const mediaObject: MediaObjectData = {
      id: attachment.id,
      author: post.author,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      signature: post.signature,
      version: '1.0',
      type: attachment.type,
      mime: attachment.mime,
      size: attachment.size,
      hash: attachment.hash,
      chunks: attachment.chunks,
    };
    await this.mediaObjectRepository.create(mediaObject);
  }

  private restoreDownloadStates(): void {
    for (const state of this.downloadRepository?.listStates() ?? []) {
      this.downloadStates.set(state.mediaObjectId, {
        ...state,
        candidatePeers: [...state.candidatePeers],
      });
    }
  }

  private async resumePendingDownloads(): Promise<void> {
    const states = [...this.downloadStates.values()].filter(
      (state) =>
        state.status === 'downloading' || state.status === 'partial' || state.status === 'failed',
    );

    for (const state of states) {
      const mediaObject = await this.mediaObjectRepository.getById(state.mediaObjectId);
      if (!mediaObject) {
        continue;
      }
      await this.enqueueMediaObjectData(mediaObject, { priority: -1 });
    }
  }

  private async processDownloadQueue(): Promise<void> {
    if (this.queueProcessing) {
      return;
    }
    this.queueProcessing = true;
    try {
      while (this.activeDownloads.size < (this.options.maxConcurrentDownloads ?? 2)) {
        const next = this.nextQueuedDownload();
        if (!next) {
          break;
        }
        this.downloadQueue.delete(next.mediaObject.id);
        this.activeDownloads.add(next.mediaObject.id);
        void this.runQueuedDownload(next);
      }
    } finally {
      this.queueProcessing = false;
    }
  }

  private nextQueuedDownload(): MediaDownloadQueueItem | null {
    return (
      [...this.downloadQueue.values()].sort(
        (left, right) => right.priority - left.priority || left.enqueuedAt - right.enqueuedAt,
      )[0] ?? null
    );
  }

  private async runQueuedDownload(item: MediaDownloadQueueItem): Promise<void> {
    try {
      await this.ensureMediaObjectAvailable(item.mediaObject, item.preferredPeerId);
    } catch (error) {
      await this.updateDownloadState(item.mediaObject.id, {
        status: 'failed',
        error: error instanceof Error ? error.message : 'Queued media download failed',
      });
    } finally {
      this.activeDownloads.delete(item.mediaObject.id);
      void this.processDownloadQueue();
    }
  }

  private emitDownloadState(state: MediaDownloadState): void {
    const snapshot = { ...state, candidatePeers: [...state.candidatePeers] };
    for (const handler of this.stateHandlers) {
      handler(snapshot);
    }
  }

  private async buildLocalAvailabilityItems(): Promise<MediaAvailabilityItem[]> {
    const mediaObjects = await this.mediaObjectRepository.getAll(500, 0);
    const items: MediaAvailabilityItem[] = [];
    const now = Date.now();

    for (const mediaObject of mediaObjects) {
      const integrity = await this.inspectAndRepairMedia(mediaObject);
      if (integrity.validChunks.length === 0) {
        continue;
      }
      items.push({
        mediaObjectId: mediaObject.id,
        chunks: integrity.validChunks.map((chunk) => chunk.id),
        totalChunks: mediaObject.chunks.length,
        updatedAt: now,
      });
    }

    return items;
  }

  private async resumeDownloadsForAvailability(
    peerId: PeerId,
    items: readonly MediaAvailabilityItem[],
  ): Promise<void> {
    for (const item of items) {
      const state = this.getDownloadState(item.mediaObjectId);
      if (
        state?.status !== 'failed' &&
        state?.status !== 'partial' &&
        state?.status !== 'queued' &&
        state?.status !== 'cancelled'
      ) {
        continue;
      }

      const mediaObject = await this.mediaObjectRepository.getById(item.mediaObjectId);
      if (!mediaObject) {
        continue;
      }
      await this.enqueueMediaObjectData(mediaObject, {
        preferredPeerId: peerId,
        priority: state.status === 'failed' || state.status === 'partial' ? 5 : 0,
      });
    }
  }
}

function mediaObjectToAttachment(mediaObject: MediaObjectData): PostMediaAttachment {
  return {
    id: mediaObject.id,
    type: mediaObject.type,
    mime: mediaObject.mime,
    size: mediaObject.size,
    hash: mediaObject.hash,
    chunks: mediaObject.chunks,
  };
}

function serializeChunk(chunk: MediaChunkData): MediaChunkResponsePayload['chunk'] {
  return {
    ...serializeChunkMetadata(chunk),
    chunkDataBase64: bytesToBase64(chunk.chunkData),
  };
}

function serializeChunkMetadata(chunk: MediaChunkData): Omit<MediaChunkData, 'chunkData'> {
  return {
    id: chunk.id,
    author: chunk.author,
    createdAt: chunk.createdAt,
    updatedAt: chunk.updatedAt,
    signature: chunk.signature,
    version: chunk.version,
    mediaObjectId: chunk.mediaObjectId,
    position: chunk.position,
    size: chunk.size,
    hash: chunk.hash,
  };
}

function deserializeChunk(chunk: MediaChunkResponsePayload['chunk']): MediaChunkData {
  const chunkData = tryBase64ToBytes(chunk.chunkDataBase64);
  if (!chunkData) {
    throw new Error('Invalid chunk base64 data');
  }
  return {
    id: chunk.id,
    author: chunk.author,
    createdAt: chunk.createdAt,
    updatedAt: chunk.updatedAt,
    signature: chunk.signature,
    version: chunk.version,
    mediaObjectId: chunk.mediaObjectId,
    position: chunk.position,
    size: chunk.size,
    hash: chunk.hash,
    chunkData,
  };
}

function deserializeChunkFromParts(parts: PendingChunkParts): MediaChunkData {
  const decodedParts = Array.from(
    { length: parts.totalParts },
    (_, index) => parts.parts.get(index) ?? new Uint8Array(),
  );
  const totalSize = decodedParts.reduce((sum, part) => sum + part.length, 0);
  const chunkData = new Uint8Array(totalSize);
  let offset = 0;
  for (const part of decodedParts) {
    chunkData.set(part, offset);
    offset += part.length;
  }
  return {
    ...parts.chunk,
    chunkData,
  };
}

async function runWithConcurrency<TItem>(
  items: TItem[],
  concurrency: number,
  handler: (item: TItem) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.floor(concurrency));
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await handler(item);
    }
  });
  await Promise.all(workers);
}

function isMediaChunkRequest(value: unknown): value is MediaChunkRequestPayload {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.version === 1 &&
    value.type === 'media.chunk.request' &&
    typeof value.mediaObjectId === 'string' &&
    typeof value.chunkId === 'string' &&
    typeof value.position === 'number'
  );
}

function isMediaChunkResponse(value: unknown): value is MediaChunkResponsePayload {
  if (!isRecord(value) || !isRecord(value.chunk)) {
    return false;
  }
  const chunk = value.chunk;
  return (
    value.version === 1 &&
    value.type === 'media.chunk.response' &&
    typeof chunk.id === 'string' &&
    typeof chunk.author === 'string' &&
    typeof chunk.createdAt === 'number' &&
    typeof chunk.updatedAt === 'number' &&
    typeof chunk.signature === 'string' &&
    typeof chunk.version === 'string' &&
    typeof chunk.mediaObjectId === 'string' &&
    typeof chunk.position === 'number' &&
    typeof chunk.size === 'number' &&
    typeof chunk.hash === 'string' &&
    typeof chunk.chunkDataBase64 === 'string'
  );
}

function isMediaChunkPart(value: unknown): value is MediaChunkPartPayload {
  if (!isRecord(value) || !isRecord(value.chunk)) {
    return false;
  }
  const chunk = value.chunk;
  return (
    value.version === 1 &&
    value.type === 'media.chunk.part' &&
    typeof chunk.id === 'string' &&
    typeof chunk.author === 'string' &&
    typeof chunk.createdAt === 'number' &&
    typeof chunk.updatedAt === 'number' &&
    typeof chunk.signature === 'string' &&
    typeof chunk.version === 'string' &&
    typeof chunk.mediaObjectId === 'string' &&
    typeof chunk.position === 'number' &&
    typeof chunk.size === 'number' &&
    typeof chunk.hash === 'string' &&
    typeof value.partIndex === 'number' &&
    typeof value.totalParts === 'number' &&
    typeof value.dataBase64 === 'string'
  );
}

function isMediaAvailabilityV2(value: unknown): value is MediaAvailabilityPayloadV2 {
  return (
    isRecord(value) &&
    value.version === 2 &&
    value.type === 'media.availability.announce' &&
    isMediaAvailabilityAnnouncementV2(value.announcement)
  );
}

function isMediaReplicaOffer(value: unknown): value is MediaReplicaOfferPayload {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.type === 'media.replica.offer' &&
    typeof value.mediaObjectId === 'string' &&
    value.mediaObjectId.length > 0 &&
    typeof value.offeredAt === 'number' &&
    Number.isFinite(value.offeredAt) &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    value.expiresAt > value.offeredAt
  );
}

function isLegacyMediaAvailability(value: unknown): value is LegacyMediaAvailabilityPayload {
  if (!isRecord(value) || !isRecord(value.manifest)) {
    return false;
  }
  const manifest = value.manifest;
  return (
    value.version === 1 &&
    value.type === 'media.availability.announce' &&
    typeof manifest.peerId === 'string' &&
    Array.isArray(manifest.items) &&
    manifest.items.every(isMediaAvailabilityItem) &&
    typeof manifest.updatedAt === 'number'
  );
}

function toMediaQuarantineReason(reason: MediaChunkIntegrityFailure): MediaQuarantineReason | null {
  switch (reason) {
    case 'chunk-data-unreadable':
    case 'chunk-position-mismatch':
    case 'chunk-media-object-mismatch':
    case 'chunk-size-invalid':
    case 'chunk-size-mismatch':
    case 'chunk-hash-mismatch':
    case 'chunk-id-mismatch':
      return reason;
    case 'chunk-not-in-manifest':
    case 'duplicate-chunk':
    case 'duplicate-position':
      return null;
  }
}

function toPartQuarantineReason(reason: string): MediaQuarantineReason | null {
  if (reason === 'invalid-base64') {
    return 'invalid-base64';
  }
  if (
    reason === 'request-metadata-mismatch' ||
    reason === 'metadata-mismatch' ||
    reason === 'conflicting-duplicate-part'
  ) {
    return 'metadata-mismatch';
  }
  return null;
}

function readableChunkEvidenceHash(chunk: MediaChunkData): string | undefined {
  try {
    return MediaIntegrityService.hashBytes(chunk.chunkData);
  } catch {
    return undefined;
  }
}

function isMediaAvailabilityItem(value: unknown): value is MediaAvailabilityItem {
  return (
    isRecord(value) &&
    typeof value.mediaObjectId === 'string' &&
    Array.isArray(value.chunks) &&
    value.chunks.every((chunkId) => typeof chunkId === 'string') &&
    typeof value.totalChunks === 'number' &&
    typeof value.updatedAt === 'number'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  if (typeof globalThis.btoa !== 'function') {
    throw new Error('Base64 encoder is unavailable');
  }
  return globalThis.btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  if (typeof globalThis.atob !== 'function') {
    throw new Error('Base64 decoder is unavailable');
  }
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function tryBase64ToBytes(base64: string): Uint8Array | null {
  if (
    base64.length === 0 ||
    base64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
  ) {
    return null;
  }
  try {
    return base64ToBytes(base64);
  } catch {
    return null;
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}
