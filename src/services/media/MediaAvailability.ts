import { canonicalize } from '@/economy/Wallet/TransactionModel';
import type { PeerId } from '@/network/NetworkTypes';
import { encodeUtf8 } from '@/utils/hash';

export const MEDIA_AVAILABILITY_VERSION = 2;
export const MEDIA_AVAILABILITY_DEFAULT_TTL_MS = 5 * 60 * 1000;
export const MEDIA_AVAILABILITY_MAX_TTL_MS = 15 * 60 * 1000;
export const MEDIA_AVAILABILITY_MAX_CLOCK_SKEW_MS = 60 * 1000;
export const MEDIA_AVAILABILITY_MAX_ITEMS_PER_PAGE = 128;
export const MEDIA_AVAILABILITY_MAX_CHUNKS_PER_ITEM = 4096;
export const MEDIA_AVAILABILITY_MAX_PAGE_BYTES = 128 * 1024;

export interface MediaAvailabilityItem {
  mediaObjectId: string;
  chunks: string[];
  totalChunks: number;
  updatedAt: number;
}

export interface LegacyMediaAvailabilityManifest {
  peerId: PeerId;
  items: MediaAvailabilityItem[];
  updatedAt: number;
}

export interface UnsignedMediaAvailabilityAnnouncementV2 {
  version: 2;
  peerId: PeerId;
  sequence: number;
  issuedAt: number;
  expiresAt: number;
  pageIndex: number;
  pageCount: number;
  items: MediaAvailabilityItem[];
}

export interface MediaAvailabilityAnnouncementV2 extends UnsignedMediaAvailabilityAnnouncementV2 {
  signature: string;
}

export interface MediaAvailabilityCrypto {
  sign(data: string): Promise<string>;
  verify(data: string, signature: string, publicIdentity: string): Promise<boolean>;
}

export type MediaAvailabilityRejectionReason =
  | 'invalid'
  | 'wrong-sender'
  | 'expired'
  | 'future'
  | 'ttl-too-long'
  | 'signature-invalid'
  | 'stale'
  | 'conflict'
  | 'duplicate'
  | 'too-large';

export type MediaAvailabilityAcceptance =
  | { accepted: true; announcement: MediaAvailabilityAnnouncementV2 }
  | { accepted: false; reason: MediaAvailabilityRejectionReason };

export type MediaReplicaObservationStatus =
  'success' | 'unavailable' | 'timeout' | 'transport-error' | 'corrupt';

export interface MediaReplicaObservation {
  id: string;
  peerId: PeerId;
  mediaObjectId: string;
  chunkId?: string;
  status: MediaReplicaObservationStatus;
  successCount: number;
  failureCount: number;
  latencyMs?: number;
  validUntil?: number;
  updatedAt: number;
}

export type MediaQuarantineReason =
  | 'invalid-base64'
  | 'metadata-mismatch'
  | 'chunk-hash-mismatch'
  | 'chunk-id-mismatch'
  | 'chunk-position-mismatch'
  | 'chunk-media-object-mismatch'
  | 'chunk-size-mismatch'
  | 'chunk-size-invalid'
  | 'chunk-data-unreadable';

export interface MediaQuarantineRecord {
  id: string;
  peerId: PeerId;
  mediaObjectId: string;
  chunkId?: string;
  reason: MediaQuarantineReason;
  evidenceHash?: string;
  failureCount: number;
  startedAt: number;
  expiresAt: number;
}

export function getMediaAvailabilitySignableBytes(
  announcement: UnsignedMediaAvailabilityAnnouncementV2,
): string {
  return canonicalize({
    version: announcement.version,
    peerId: announcement.peerId,
    sequence: announcement.sequence,
    issuedAt: announcement.issuedAt,
    expiresAt: announcement.expiresAt,
    pageIndex: announcement.pageIndex,
    pageCount: announcement.pageCount,
    items: announcement.items.map((item) => ({
      mediaObjectId: item.mediaObjectId,
      chunks: [...item.chunks],
      totalChunks: item.totalChunks,
      updatedAt: item.updatedAt,
    })),
  });
}

export function withoutMediaAvailabilitySignature(
  announcement: MediaAvailabilityAnnouncementV2,
): UnsignedMediaAvailabilityAnnouncementV2 {
  return {
    version: announcement.version,
    peerId: announcement.peerId,
    sequence: announcement.sequence,
    issuedAt: announcement.issuedAt,
    expiresAt: announcement.expiresAt,
    pageIndex: announcement.pageIndex,
    pageCount: announcement.pageCount,
    items: announcement.items.map(cloneMediaAvailabilityItem),
  };
}

export function cloneMediaAvailabilityItem(item: MediaAvailabilityItem): MediaAvailabilityItem {
  return {
    ...item,
    chunks: [...item.chunks],
  };
}

export function cloneMediaAvailabilityAnnouncement(
  announcement: MediaAvailabilityAnnouncementV2,
): MediaAvailabilityAnnouncementV2 {
  return {
    ...announcement,
    items: announcement.items.map(cloneMediaAvailabilityItem),
  };
}

export function isMediaAvailabilityItem(value: unknown): value is MediaAvailabilityItem {
  return (
    isRecord(value) &&
    isBoundedString(value.mediaObjectId) &&
    Array.isArray(value.chunks) &&
    value.chunks.length <= MEDIA_AVAILABILITY_MAX_CHUNKS_PER_ITEM &&
    value.chunks.every((chunkId) => isBoundedString(chunkId)) &&
    new Set(value.chunks).size === value.chunks.length &&
    isNonNegativeInteger(value.totalChunks) &&
    value.totalChunks >= value.chunks.length &&
    isTimestamp(value.updatedAt)
  );
}

export function isMediaAvailabilityAnnouncementV2(
  value: unknown,
): value is MediaAvailabilityAnnouncementV2 {
  return (
    isRecord(value) &&
    value.version === MEDIA_AVAILABILITY_VERSION &&
    isBoundedString(value.peerId) &&
    isPositiveInteger(value.sequence) &&
    isTimestamp(value.issuedAt) &&
    isTimestamp(value.expiresAt) &&
    isNonNegativeInteger(value.pageIndex) &&
    isPositiveInteger(value.pageCount) &&
    value.pageIndex < value.pageCount &&
    Array.isArray(value.items) &&
    value.items.length > 0 &&
    value.items.length <= MEDIA_AVAILABILITY_MAX_ITEMS_PER_PAGE &&
    value.items.every(isMediaAvailabilityItem) &&
    new Set(value.items.map((item) => item.mediaObjectId)).size === value.items.length &&
    isBoundedString(value.signature, 1024)
  );
}

export function isMediaReplicaObservationStatus(
  value: unknown,
): value is MediaReplicaObservationStatus {
  return (
    value === 'success' ||
    value === 'unavailable' ||
    value === 'timeout' ||
    value === 'transport-error' ||
    value === 'corrupt'
  );
}

export function isMediaQuarantineReason(value: unknown): value is MediaQuarantineReason {
  return (
    value === 'invalid-base64' ||
    value === 'metadata-mismatch' ||
    value === 'chunk-hash-mismatch' ||
    value === 'chunk-id-mismatch' ||
    value === 'chunk-position-mismatch' ||
    value === 'chunk-media-object-mismatch' ||
    value === 'chunk-size-mismatch' ||
    value === 'chunk-size-invalid' ||
    value === 'chunk-data-unreadable'
  );
}

export function estimateMediaAvailabilityBytes(value: unknown): number {
  return encodeUtf8(JSON.stringify(value)).length;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function isOptionalString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === 'string';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}
