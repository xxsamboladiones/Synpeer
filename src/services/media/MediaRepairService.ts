import type { MediaObjectData } from '@/models/MediaObject';
import type { PeerId } from '@/network/NetworkTypes';
import { createLogger, type Logger } from '@/observability/Logger';
import type { MediaChunkRepository } from '@/repositories/MediaChunkRepository';
import type { MediaObjectRepository } from '@/repositories/MediaObjectRepository';

import type { MediaAvailabilityAnnouncementV2 } from './MediaAvailability';
import type { MediaDownloadRepository } from './MediaDownloadRepository';
import { MediaIntegrityService } from './MediaIntegrityService';

export interface MediaRepairPolicy {
  minReplicas: number;
  desiredReplicas: number;
  maxOffersPerRun: number;
  offerTimeoutMs: number;
  retryBackoffMs: number;
}

export interface MediaRepairAdapter {
  getEligiblePeers(): PeerId[];
  offerReplica(peerId: PeerId, mediaObjectId: string): Promise<boolean>;
}

export interface MediaRepairSnapshot {
  running: boolean;
  queuedObjects: number;
  pendingOffers: number;
  confirmedRepairs: number;
  failedOffers: number;
  underReplicatedObjects: number;
  lastRepairAt: number | null;
  lastConfirmedAt: number | null;
  lastError: string | null;
}

export type MediaRepairSnapshotHandler = (snapshot: MediaRepairSnapshot) => void;

interface PendingReplicaOffer {
  peerId: PeerId;
  mediaObjectId: string;
  expiresAt: number;
}

const DEFAULT_POLICY: MediaRepairPolicy = {
  minReplicas: 2,
  desiredReplicas: 3,
  maxOffersPerRun: 4,
  offerTimeoutMs: 60_000,
  retryBackoffMs: 30_000,
};

export class MediaRepairService {
  private readonly logger: Logger;
  private readonly policy: MediaRepairPolicy;
  private readonly pendingOffers = new Map<string, PendingReplicaOffer>();
  private readonly retryAfter = new Map<string, number>();
  private readonly snapshotHandlers = new Set<MediaRepairSnapshotHandler>();
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private runPromise: Promise<void> | null = null;
  private started = false;
  private queuedObjects = 0;
  private confirmedRepairs = 0;
  private failedOffers = 0;
  private underReplicatedObjects = 0;
  private lastRepairAt: number | null = null;
  private lastConfirmedAt: number | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly localPeerId: PeerId,
    private readonly mediaObjectRepository: Pick<
      MediaObjectRepository,
      'getAll' | 'getById' | 'getCount'
    >,
    private readonly mediaChunkRepository: Pick<MediaChunkRepository, 'getByMediaObjectId'>,
    private readonly downloadRepository: Pick<
      MediaDownloadRepository,
      'findCompleteReplicaPeers' | 'isReplicaQuarantined'
    >,
    private readonly adapter: MediaRepairAdapter,
    private readonly integrityService: MediaIntegrityService = new MediaIntegrityService(),
    policy: Partial<MediaRepairPolicy> = {},
    logger: Logger = createLogger('MediaRepairService'),
    private readonly now: () => number = Date.now,
  ) {
    this.logger = logger;
    this.policy = normalizePolicy(policy);
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.emitSnapshot();
    this.scheduleRepair('startup');
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      globalThis.clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingOffers.clear();
    this.retryAfter.clear();
    this.queuedObjects = 0;
    this.emitSnapshot();
  }

  scheduleRepair(reason: string, delayMs = 0): void {
    if (!this.started) {
      return;
    }
    if (this.timer) {
      if (delayMs > 0) {
        return;
      }
      globalThis.clearTimeout(this.timer);
    }
    this.timer = globalThis.setTimeout(
      () => {
        this.timer = null;
        void this.runRepair(reason);
      },
      Math.max(0, delayMs),
    );
  }

  async runRepair(reason = 'manual'): Promise<void> {
    if (!this.started) {
      return;
    }
    if (this.runPromise) {
      await this.runPromise;
      return;
    }
    this.runPromise = this.performRepair(reason);
    try {
      await this.runPromise;
    } finally {
      this.runPromise = null;
    }
  }

  handleAvailabilityAnnouncement(announcement: MediaAvailabilityAnnouncementV2): void {
    if (!this.started || announcement.peerId === this.localPeerId) {
      return;
    }
    const offeredMediaIds = new Set(
      [...this.pendingOffers.values()]
        .filter((offer) => offer.peerId === announcement.peerId)
        .map((offer) => offer.mediaObjectId),
    );
    for (const mediaObjectId of offeredMediaIds) {
      void this.confirmOfferIfComplete(announcement.peerId, mediaObjectId).catch((error) => {
        this.logger.warn('media_repair_confirmation_failed', {
          peerId: announcement.peerId,
          mediaObjectId,
          error: error instanceof Error ? error.message : 'Replica confirmation failed',
        });
      });
    }
    this.scheduleRepair('availability-announced');
  }

  getSnapshot(): MediaRepairSnapshot {
    return {
      running: this.started,
      queuedObjects: this.queuedObjects,
      pendingOffers: this.pendingOffers.size,
      confirmedRepairs: this.confirmedRepairs,
      failedOffers: this.failedOffers,
      underReplicatedObjects: this.underReplicatedObjects,
      lastRepairAt: this.lastRepairAt,
      lastConfirmedAt: this.lastConfirmedAt,
      lastError: this.lastError,
    };
  }

  subscribe(handler: MediaRepairSnapshotHandler): () => void {
    this.snapshotHandlers.add(handler);
    handler(this.getSnapshot());
    return () => {
      this.snapshotHandlers.delete(handler);
    };
  }

  private async performRepair(reason: string): Promise<void> {
    const now = this.now();
    this.expirePendingOffers(now);
    this.lastError = null;
    try {
      const mediaObjects = await this.listLocalAvailableMedia();
      this.queuedObjects = mediaObjects.length;
      this.underReplicatedObjects = 0;
      let offersRemaining = this.policy.maxOffersPerRun;

      for (const mediaObject of mediaObjects) {
        const replicas = this.downloadRepository.findCompleteReplicaPeers(
          mediaObject.id,
          mediaObject.chunks,
          now,
        );
        if (replicas.length >= this.policy.minReplicas) {
          continue;
        }
        this.underReplicatedObjects += 1;
        const pendingPeers = new Set(
          [...this.pendingOffers.values()]
            .filter((offer) => offer.mediaObjectId === mediaObject.id)
            .map((offer) => offer.peerId),
        );
        const requiredOffers = Math.max(
          0,
          this.policy.desiredReplicas - replicas.length - pendingPeers.size,
        );
        if (requiredOffers === 0 || offersRemaining === 0) {
          continue;
        }

        const replicaPeers = new Set(replicas);
        const candidates = this.adapter
          .getEligiblePeers()
          .filter(
            (peerId) =>
              peerId !== this.localPeerId &&
              !replicaPeers.has(peerId) &&
              !pendingPeers.has(peerId) &&
              !this.isBackedOff(peerId, mediaObject.id, now) &&
              !mediaObject.chunks.some((chunkId) =>
                this.downloadRepository.isReplicaQuarantined(peerId, mediaObject.id, chunkId, now),
              ),
          )
          .sort((left, right) => String(left).localeCompare(String(right)))
          .slice(0, Math.min(requiredOffers, offersRemaining));

        for (const peerId of candidates) {
          const sent = await this.adapter.offerReplica(peerId, mediaObject.id);
          offersRemaining -= 1;
          if (!sent) {
            this.failedOffers += 1;
            this.retryAfter.set(
              createOfferKey(peerId, mediaObject.id),
              now + this.policy.retryBackoffMs,
            );
            continue;
          }
          this.pendingOffers.set(createOfferKey(peerId, mediaObject.id), {
            peerId,
            mediaObjectId: mediaObject.id,
            expiresAt: now + this.policy.offerTimeoutMs,
          });
        }
      }

      this.queuedObjects = 0;
      this.lastRepairAt = now;
      this.logger.info('media_repair_completed', {
        reason,
        pendingOffers: this.pendingOffers.size,
        underReplicatedObjects: this.underReplicatedObjects,
      });
      this.emitSnapshot();
      this.scheduleNextExpiry(now);
    } catch (error) {
      this.queuedObjects = 0;
      this.lastError = error instanceof Error ? error.message : 'Media repair failed';
      this.logger.warn('media_repair_failed', {
        reason,
        error: this.lastError,
      });
      this.emitSnapshot();
      this.scheduleRepair('retry-after-error', this.policy.retryBackoffMs);
    }
  }

  private async listLocalAvailableMedia(): Promise<MediaObjectData[]> {
    const count = await this.mediaObjectRepository.getCount();
    if (count === 0) {
      return [];
    }
    const mediaObjects = await this.mediaObjectRepository.getAll(count, 0);
    const available: MediaObjectData[] = [];
    for (const mediaObject of mediaObjects) {
      const chunks = await this.mediaChunkRepository.getByMediaObjectId(mediaObject.id);
      if (this.integrityService.inspectMedia(mediaObject, chunks).available) {
        available.push(mediaObject);
      }
    }
    return available.sort((left, right) => left.id.localeCompare(right.id));
  }

  private async confirmOfferIfComplete(peerId: PeerId, mediaObjectId: string): Promise<void> {
    const offerKey = createOfferKey(peerId, mediaObjectId);
    if (!this.pendingOffers.has(offerKey)) {
      return;
    }
    const mediaObject = await this.mediaObjectRepository.getById(mediaObjectId);
    if (!mediaObject) {
      return;
    }
    const completePeers = this.downloadRepository.findCompleteReplicaPeers(
      mediaObjectId,
      mediaObject.chunks,
      this.now(),
    );
    if (!completePeers.includes(peerId)) {
      return;
    }
    this.pendingOffers.delete(offerKey);
    this.retryAfter.delete(offerKey);
    this.confirmedRepairs += 1;
    this.lastConfirmedAt = this.now();
    this.logger.info('media_repair_replica_confirmed', { peerId, mediaObjectId });
    this.emitSnapshot();
    this.scheduleRepair('replica-confirmed');
  }

  private expirePendingOffers(now: number): void {
    for (const [key, offer] of this.pendingOffers.entries()) {
      if (offer.expiresAt > now) {
        continue;
      }
      this.pendingOffers.delete(key);
      this.retryAfter.set(key, now + this.policy.retryBackoffMs);
      this.failedOffers += 1;
    }
    for (const [key, retryAt] of this.retryAfter.entries()) {
      if (retryAt <= now) {
        this.retryAfter.delete(key);
      }
    }
  }

  private isBackedOff(peerId: PeerId, mediaObjectId: string, now: number): boolean {
    return (this.retryAfter.get(createOfferKey(peerId, mediaObjectId)) ?? 0) > now;
  }

  private scheduleNextExpiry(now: number): void {
    const nextDeadline = Math.min(
      ...[...this.pendingOffers.values()].map((offer) => offer.expiresAt),
      ...this.retryAfter.values(),
    );
    if (Number.isFinite(nextDeadline)) {
      this.scheduleRepair('offer-expired', Math.max(1, nextDeadline - now));
    }
  }

  private emitSnapshot(): void {
    const snapshot = this.getSnapshot();
    for (const handler of this.snapshotHandlers) {
      handler(snapshot);
    }
  }
}

function normalizePolicy(policy: Partial<MediaRepairPolicy>): MediaRepairPolicy {
  const minReplicas = Math.max(1, Math.floor(policy.minReplicas ?? DEFAULT_POLICY.minReplicas));
  return {
    minReplicas,
    desiredReplicas: Math.max(
      minReplicas,
      Math.floor(policy.desiredReplicas ?? DEFAULT_POLICY.desiredReplicas),
    ),
    maxOffersPerRun: Math.max(
      1,
      Math.floor(policy.maxOffersPerRun ?? DEFAULT_POLICY.maxOffersPerRun),
    ),
    offerTimeoutMs: Math.max(1, policy.offerTimeoutMs ?? DEFAULT_POLICY.offerTimeoutMs),
    retryBackoffMs: Math.max(1, policy.retryBackoffMs ?? DEFAULT_POLICY.retryBackoffMs),
  };
}

function createOfferKey(peerId: PeerId, mediaObjectId: string): string {
  return `${peerId}:${mediaObjectId}`;
}
