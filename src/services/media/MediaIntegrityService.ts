import type { MediaChunkData } from '@/models/MediaChunk';
import type { MediaObjectData } from '@/models/MediaObject';
import { sha256Hex } from '@/utils/hash';

export type MediaChunkIntegrityFailure =
  | 'chunk-data-unreadable'
  | 'chunk-not-in-manifest'
  | 'chunk-position-mismatch'
  | 'chunk-media-object-mismatch'
  | 'chunk-size-invalid'
  | 'chunk-size-mismatch'
  | 'chunk-hash-mismatch'
  | 'chunk-id-mismatch'
  | 'duplicate-chunk'
  | 'duplicate-position';

export interface MediaIntegrityDescriptor {
  id: string;
  size: number;
  hash: string;
  chunks: readonly string[];
}

export interface MediaChunkExpectation {
  mediaObjectId: string;
  chunkId: string;
  position: number;
}

export interface InvalidMediaChunk {
  chunkId: string;
  position: number;
  reason: MediaChunkIntegrityFailure;
}

export interface MediaIntegrityReport {
  available: boolean;
  complete: boolean;
  fileHashValid: boolean;
  validChunks: MediaChunkData[];
  invalidChunks: InvalidMediaChunk[];
  missingChunkIds: string[];
  fileData?: Uint8Array;
}

export type MediaChunkValidationResult =
  | { valid: true; chunk: MediaChunkData }
  | {
      valid: false;
      reason: MediaChunkIntegrityFailure;
      chunkId: string;
      position: number;
    };

/**
 * Central integrity boundary for local ingestion, persisted chunks and P2P media.
 */
export class MediaIntegrityService {
  static hashBytes(bytes: Uint8Array): string {
    return sha256Hex(bytes);
  }

  static createChunkId(mediaObjectId: string, position: number, hash: string): string {
    return `chunk_${mediaObjectId}_${position}_${hash.substring(0, 16)}`;
  }

  validateChunk(
    chunk: MediaChunkData,
    expectation?: MediaChunkExpectation,
  ): MediaChunkValidationResult {
    const bytes = normalizeBinaryData(chunk.chunkData);
    if (!bytes) {
      return invalidChunk(chunk, 'chunk-data-unreadable');
    }
    if (!Number.isSafeInteger(chunk.position) || chunk.position < 0) {
      return invalidChunk(chunk, 'chunk-position-mismatch');
    }
    if (!Number.isSafeInteger(chunk.size) || chunk.size <= 0) {
      return invalidChunk(chunk, 'chunk-size-invalid');
    }
    if (bytes.length !== chunk.size) {
      return invalidChunk(chunk, 'chunk-size-mismatch');
    }

    const calculatedHash = MediaIntegrityService.hashBytes(bytes);
    if (calculatedHash !== chunk.hash) {
      return invalidChunk(chunk, 'chunk-hash-mismatch');
    }

    if (expectation) {
      if (chunk.mediaObjectId !== expectation.mediaObjectId) {
        return invalidChunk(chunk, 'chunk-media-object-mismatch');
      }
      if (chunk.id !== expectation.chunkId) {
        return invalidChunk(chunk, 'chunk-id-mismatch');
      }
      if (chunk.position !== expectation.position) {
        return invalidChunk(chunk, 'chunk-position-mismatch');
      }
    }

    const deterministicId = MediaIntegrityService.createChunkId(
      chunk.mediaObjectId,
      chunk.position,
      chunk.hash,
    );
    if (chunk.id !== deterministicId) {
      return invalidChunk(chunk, 'chunk-id-mismatch');
    }

    return {
      valid: true,
      chunk: {
        ...chunk,
        chunkData: bytes,
      },
    };
  }

  inspectMedia(
    media: MediaIntegrityDescriptor,
    storedChunks: readonly MediaChunkData[],
  ): MediaIntegrityReport {
    const expectedPositions = new Map<string, number>();
    media.chunks.forEach((chunkId, position) => {
      if (!expectedPositions.has(chunkId)) {
        expectedPositions.set(chunkId, position);
      }
    });

    const validChunks: MediaChunkData[] = [];
    const invalidChunks: InvalidMediaChunk[] = [];
    const seenChunkIds = new Set<string>();
    const seenPositions = new Set<number>();

    for (const storedChunk of storedChunks) {
      const expectedPosition = expectedPositions.get(storedChunk.id);
      if (expectedPosition === undefined) {
        invalidChunks.push(toInvalidChunk(storedChunk, 'chunk-not-in-manifest'));
        continue;
      }
      if (seenChunkIds.has(storedChunk.id)) {
        invalidChunks.push(toInvalidChunk(storedChunk, 'duplicate-chunk'));
        continue;
      }
      if (seenPositions.has(storedChunk.position)) {
        invalidChunks.push(toInvalidChunk(storedChunk, 'duplicate-position'));
        continue;
      }

      const validation = this.validateChunk(storedChunk, {
        mediaObjectId: media.id,
        chunkId: storedChunk.id,
        position: expectedPosition,
      });
      if (!validation.valid) {
        invalidChunks.push({
          chunkId: validation.chunkId,
          position: validation.position,
          reason: validation.reason,
        });
        continue;
      }

      seenChunkIds.add(validation.chunk.id);
      seenPositions.add(validation.chunk.position);
      validChunks.push(validation.chunk);
    }

    validChunks.sort((left, right) => left.position - right.position);
    const validChunkIds = new Set(validChunks.map((chunk) => chunk.id));
    const missingChunkIds = media.chunks.filter((chunkId) => !validChunkIds.has(chunkId));
    const complete =
      media.chunks.length > 0 &&
      expectedPositions.size === media.chunks.length &&
      missingChunkIds.length === 0;

    if (!complete) {
      return {
        available: false,
        complete: false,
        fileHashValid: false,
        validChunks,
        invalidChunks,
        missingChunkIds,
      };
    }

    const fileData = this.reassemble(validChunks);
    const fileHashValid =
      fileData.length === media.size && MediaIntegrityService.hashBytes(fileData) === media.hash;
    return {
      available: fileHashValid,
      complete: true,
      fileHashValid,
      validChunks,
      invalidChunks,
      missingChunkIds,
      fileData: fileHashValid ? fileData : undefined,
    };
  }

  reassemble(chunks: readonly MediaChunkData[]): Uint8Array {
    const sortedChunks = [...chunks].sort((left, right) => left.position - right.position);
    const totalSize = sortedChunks.reduce((sum, chunk) => sum + chunk.chunkData.length, 0);
    const fileData = new Uint8Array(totalSize);
    let offset = 0;

    for (const chunk of sortedChunks) {
      fileData.set(chunk.chunkData, offset);
      offset += chunk.chunkData.length;
    }
    return fileData;
  }
}

function normalizeBinaryData(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) {
    return isByteArray(value) ? new Uint8Array(value) : null;
  }
  if (!isRecord(value)) {
    return null;
  }

  const entries = Object.entries(value);
  if (
    entries.length === 0 ||
    entries.some(([key, entry]) => !isArrayIndex(key) || !isByte(entry))
  ) {
    return null;
  }
  const ordered: Array<readonly [number, number]> = [];
  for (const [key, entry] of entries) {
    if (!isByte(entry)) {
      return null;
    }
    ordered.push([Number(key), entry]);
  }
  ordered.sort(([left], [right]) => left - right);
  if (ordered.some(([index], expectedIndex) => index !== expectedIndex)) {
    return null;
  }
  return new Uint8Array(ordered.map(([, entry]) => entry));
}

function invalidChunk(
  chunk: MediaChunkData,
  reason: MediaChunkIntegrityFailure,
): MediaChunkValidationResult {
  return {
    valid: false,
    reason,
    chunkId: typeof chunk.id === 'string' ? chunk.id : '',
    position: Number.isSafeInteger(chunk.position) ? chunk.position : -1,
  };
}

function toInvalidChunk(
  chunk: MediaChunkData,
  reason: MediaChunkIntegrityFailure,
): InvalidMediaChunk {
  return {
    chunkId: typeof chunk.id === 'string' ? chunk.id : '',
    position: Number.isSafeInteger(chunk.position) ? chunk.position : -1,
    reason,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArrayIndex(value: string): boolean {
  return /^(0|[1-9]\d*)$/.test(value);
}

function isByte(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;
}

function isByteArray(value: unknown[]): value is number[] {
  return value.every(isByte);
}

export type MediaIntegrityObject = Pick<MediaObjectData, 'id' | 'size' | 'hash' | 'chunks'>;
