import { AppError } from '@/errors/AppError';
import type { PeerId } from '@/network/NetworkTypes';

import {
  cloneMediaAvailabilityItem,
  estimateMediaAvailabilityBytes,
  getMediaAvailabilitySignableBytes,
  isMediaAvailabilityAnnouncementV2,
  MEDIA_AVAILABILITY_DEFAULT_TTL_MS,
  MEDIA_AVAILABILITY_MAX_CLOCK_SKEW_MS,
  MEDIA_AVAILABILITY_MAX_ITEMS_PER_PAGE,
  MEDIA_AVAILABILITY_MAX_PAGE_BYTES,
  MEDIA_AVAILABILITY_MAX_TTL_MS,
  MEDIA_AVAILABILITY_VERSION,
  type MediaAvailabilityAcceptance,
  type MediaAvailabilityAnnouncementV2,
  type MediaAvailabilityCrypto,
  type MediaAvailabilityItem,
  type UnsignedMediaAvailabilityAnnouncementV2,
  withoutMediaAvailabilitySignature,
} from './MediaAvailability';
import type { MediaDownloadRepository } from './MediaDownloadRepository';

const MAX_CHUNKS_PER_PAGE_ITEM = 128;
const SIGNATURE_SIZE_RESERVE_BYTES = 1024;

export interface MediaAvailabilityServiceOptions {
  ttlMs?: number;
  maxClockSkewMs?: number;
  now?: () => number;
}

export interface MediaAvailabilityInitializationResult {
  invalidAnnouncementsRemoved: number;
  expiredAnnouncementsRemoved: number;
}

export type MediaAvailabilityAcceptedHandler = (
  announcement: MediaAvailabilityAnnouncementV2,
) => void;

export class MediaAvailabilityService {
  private readonly now: () => number;
  private readonly acceptedHandlers = new Set<MediaAvailabilityAcceptedHandler>();

  constructor(
    private readonly localPeerId: PeerId,
    private readonly crypto: MediaAvailabilityCrypto,
    private readonly repository: MediaDownloadRepository,
    private readonly options: MediaAvailabilityServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<MediaAvailabilityInitializationResult> {
    const now = this.now();
    let invalidAnnouncementsRemoved = 0;
    for (const announcement of this.repository.listAnnouncements()) {
      const timestampsValid =
        announcement.issuedAt <=
          now + (this.options.maxClockSkewMs ?? MEDIA_AVAILABILITY_MAX_CLOCK_SKEW_MS) &&
        announcement.expiresAt > announcement.issuedAt &&
        announcement.expiresAt - announcement.issuedAt <= MEDIA_AVAILABILITY_MAX_TTL_MS;
      const signatureValid =
        timestampsValid &&
        (await this.crypto.verify(
          getMediaAvailabilitySignableBytes(withoutMediaAvailabilitySignature(announcement)),
          announcement.signature,
          announcement.peerId,
        ));
      if (signatureValid) {
        continue;
      }
      await this.repository.removeAnnouncement(announcement);
      invalidAnnouncementsRemoved += 1;
    }

    return {
      invalidAnnouncementsRemoved,
      expiredAnnouncementsRemoved: await this.repository.pruneExpiredAnnouncements(now),
    };
  }

  async createAnnouncements(
    items: readonly MediaAvailabilityItem[],
  ): Promise<MediaAvailabilityAnnouncementV2[]> {
    const normalizedItems = normalizeItems(items);
    if (normalizedItems.length === 0) {
      return [];
    }

    const now = this.now();
    const ttlMs = Math.min(
      Math.max(1, this.options.ttlMs ?? MEDIA_AVAILABILITY_DEFAULT_TTL_MS),
      MEDIA_AVAILABILITY_MAX_TTL_MS,
    );
    const sequence = this.repository.getLatestAnnouncementSequence(this.localPeerId) + 1;
    const itemPages = paginateAvailabilityItems(normalizedItems, {
      peerId: this.localPeerId,
      sequence,
      issuedAt: now,
      expiresAt: now + ttlMs,
    });
    const announcements: MediaAvailabilityAnnouncementV2[] = [];

    for (let pageIndex = 0; pageIndex < itemPages.length; pageIndex += 1) {
      const unsigned: UnsignedMediaAvailabilityAnnouncementV2 = {
        version: MEDIA_AVAILABILITY_VERSION,
        peerId: this.localPeerId,
        sequence,
        issuedAt: now,
        expiresAt: now + ttlMs,
        pageIndex,
        pageCount: itemPages.length,
        items: itemPages[pageIndex],
      };
      const signature = await this.crypto.sign(getMediaAvailabilitySignableBytes(unsigned));
      const announcement: MediaAvailabilityAnnouncementV2 = {
        ...unsigned,
        signature,
      };
      if (estimateMediaAvailabilityBytes(announcement) > MEDIA_AVAILABILITY_MAX_PAGE_BYTES) {
        throw new AppError({
          code: 'MEDIA_ERROR',
          message: 'Signed media availability page exceeds the protocol size limit',
          safeMessage: 'A disponibilidade de midia local e grande demais para ser anunciada.',
          severity: 'error',
          retryable: false,
          context: {
            scope: 'media.availability',
            pageIndex,
            pageCount: itemPages.length,
          },
        });
      }
      await this.repository.saveAnnouncement(announcement);
      announcements.push(announcement);
    }

    return announcements;
  }

  async acceptAnnouncement(
    value: unknown,
    sourcePeerId: PeerId,
  ): Promise<MediaAvailabilityAcceptance> {
    if (!isMediaAvailabilityAnnouncementV2(value)) {
      return { accepted: false, reason: 'invalid' };
    }
    if (value.peerId !== sourcePeerId) {
      return { accepted: false, reason: 'wrong-sender' };
    }

    const now = this.now();
    if (value.expiresAt <= now) {
      return { accepted: false, reason: 'expired' };
    }
    if (
      value.issuedAt >
      now + (this.options.maxClockSkewMs ?? MEDIA_AVAILABILITY_MAX_CLOCK_SKEW_MS)
    ) {
      return { accepted: false, reason: 'future' };
    }
    if (
      value.expiresAt <= value.issuedAt ||
      value.expiresAt - value.issuedAt > MEDIA_AVAILABILITY_MAX_TTL_MS
    ) {
      return { accepted: false, reason: 'ttl-too-long' };
    }
    if (estimateMediaAvailabilityBytes(value) > MEDIA_AVAILABILITY_MAX_PAGE_BYTES) {
      return { accepted: false, reason: 'too-large' };
    }

    const verified = await this.crypto.verify(
      getMediaAvailabilitySignableBytes(withoutMediaAvailabilitySignature(value)),
      value.signature,
      value.peerId,
    );
    if (!verified) {
      return { accepted: false, reason: 'signature-invalid' };
    }

    const persistenceResult = await this.repository.saveAnnouncement(value);
    if (persistenceResult === 'stale') {
      return { accepted: false, reason: 'stale' };
    }
    if (persistenceResult === 'duplicate') {
      return { accepted: false, reason: 'duplicate' };
    }
    if (persistenceResult === 'conflict') {
      return { accepted: false, reason: 'conflict' };
    }

    const announcement = { ...value, items: value.items.map(cloneMediaAvailabilityItem) };
    for (const handler of this.acceptedHandlers) {
      handler(announcement);
    }

    return { accepted: true, announcement };
  }

  subscribeAccepted(handler: MediaAvailabilityAcceptedHandler): () => void {
    this.acceptedHandlers.add(handler);
    return () => {
      this.acceptedHandlers.delete(handler);
    };
  }

  async pruneExpired(): Promise<number> {
    return await this.repository.pruneExpiredAnnouncements(this.now());
  }
}

function normalizeItems(items: readonly MediaAvailabilityItem[]): MediaAvailabilityItem[] {
  return items
    .filter((item) => item.chunks.length > 0)
    .map((item) => ({
      mediaObjectId: item.mediaObjectId,
      chunks: Array.from(new Set(item.chunks)).sort(),
      totalChunks: Math.max(item.totalChunks, item.chunks.length),
      updatedAt: item.updatedAt,
    }))
    .sort((left, right) => left.mediaObjectId.localeCompare(right.mediaObjectId));
}

function paginateAvailabilityItems(
  items: readonly MediaAvailabilityItem[],
  base: Pick<
    UnsignedMediaAvailabilityAnnouncementV2,
    'peerId' | 'sequence' | 'issuedAt' | 'expiresAt'
  >,
): MediaAvailabilityItem[][] {
  const fragments = items.flatMap((item) => {
    const result: MediaAvailabilityItem[] = [];
    for (let index = 0; index < item.chunks.length; index += MAX_CHUNKS_PER_PAGE_ITEM) {
      result.push({
        ...cloneMediaAvailabilityItem(item),
        chunks: item.chunks.slice(index, index + MAX_CHUNKS_PER_PAGE_ITEM),
      });
    }
    return result;
  });
  const pages: MediaAvailabilityItem[][] = [];

  for (const fragment of fragments) {
    const current = pages.at(-1) ?? [];
    const hasSameObject = current.some((item) => item.mediaObjectId === fragment.mediaObjectId);
    const candidate = hasSameObject ? [fragment] : [...current, fragment];
    const estimated = estimateMediaAvailabilityBytes({
      version: MEDIA_AVAILABILITY_VERSION,
      ...base,
      pageIndex: pages.length,
      pageCount: Math.max(1, pages.length + 1),
      items: candidate,
      signature: '0'.repeat(SIGNATURE_SIZE_RESERVE_BYTES),
    });

    if (
      current.length === 0 ||
      (!hasSameObject &&
        candidate.length <= MEDIA_AVAILABILITY_MAX_ITEMS_PER_PAGE &&
        estimated <= MEDIA_AVAILABILITY_MAX_PAGE_BYTES)
    ) {
      if (pages.length === 0) {
        pages.push(candidate);
      } else {
        pages[pages.length - 1] = candidate;
      }
      continue;
    }
    pages.push([fragment]);
  }

  return pages;
}
