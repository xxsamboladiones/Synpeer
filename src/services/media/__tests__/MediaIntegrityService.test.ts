import { MediaChunk, type MediaChunkData } from '@/models/MediaChunk';
import type { PeerId } from '@/network/NetworkTypes';

import { MediaIntegrityService, type MediaIntegrityDescriptor } from '../MediaIntegrityService';

const peerId = 'peer-media-owner' as PeerId;

describe('MediaIntegrityService', () => {
  it('validates and reassembles a complete file independently of chunk arrival order', () => {
    const service = new MediaIntegrityService();
    const chunks = createChunks('media-valid', [
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4]),
      new Uint8Array([5]),
    ]);
    const media = createDescriptor('media-valid', chunks);

    const report = service.inspectMedia(media, [chunks[2], chunks[0], chunks[1]]);

    expect(report).toMatchObject({
      available: true,
      complete: true,
      fileHashValid: true,
      invalidChunks: [],
      missingChunkIds: [],
    });
    expect(Array.from(report.fileData ?? [])).toEqual([1, 2, 3, 4, 5]);
  });

  it('identifies only the altered chunk and keeps the other chunks resumable', () => {
    const service = new MediaIntegrityService();
    const chunks = createChunks('media-corrupt', [
      new Uint8Array([10, 11]),
      new Uint8Array([12, 13]),
      new Uint8Array([14, 15]),
    ]);
    const media = createDescriptor('media-corrupt', chunks);
    const corrupted = {
      ...chunks[1],
      chunkData: new Uint8Array([99, 13]),
    };

    const report = service.inspectMedia(media, [chunks[0], corrupted, chunks[2]]);

    expect(report.available).toBe(false);
    expect(report.validChunks.map((chunk) => chunk.id)).toEqual([chunks[0].id, chunks[2].id]);
    expect(report.invalidChunks).toEqual([
      {
        chunkId: chunks[1].id,
        position: 1,
        reason: 'chunk-hash-mismatch',
      },
    ]);
    expect(report.missingChunkIds).toEqual([chunks[1].id]);
  });

  it('rejects a chunk whose deterministic id does not match its hash and position', () => {
    const service = new MediaIntegrityService();
    const [chunk] = createChunks('media-id', [new Uint8Array([20, 21])]);

    const result = service.validateChunk(
      {
        ...chunk,
        id: 'chunk-forged',
      },
      {
        mediaObjectId: 'media-id',
        chunkId: 'chunk-forged',
        position: 0,
      },
    );

    expect(result).toMatchObject({
      valid: false,
      reason: 'chunk-id-mismatch',
    });
  });

  it('reports duplicate, missing and out-of-range positions without discarding valid chunks', () => {
    const service = new MediaIntegrityService();
    const chunks = createChunks('media-position', [
      new Uint8Array([22]),
      new Uint8Array([23]),
      new Uint8Array([24]),
    ]);
    const media = createDescriptor('media-position', chunks);
    const duplicatePosition = {
      ...chunks[1],
      position: 0,
    };
    const outOfRangePosition = {
      ...chunks[2],
      position: 99,
    };

    const report = service.inspectMedia(media, [chunks[0], duplicatePosition, outOfRangePosition]);

    expect(report.available).toBe(false);
    expect(report.validChunks).toEqual([chunks[0]]);
    expect(report.invalidChunks.map((chunk) => chunk.reason)).toEqual([
      'duplicate-position',
      'chunk-position-mismatch',
    ]);
    expect(report.missingChunkIds).toEqual([chunks[1].id, chunks[2].id]);
  });

  it('does not expose bytes when the complete object hash is invalid', () => {
    const service = new MediaIntegrityService();
    const chunks = createChunks('media-file-hash', [new Uint8Array([30]), new Uint8Array([31])]);
    const media = {
      ...createDescriptor('media-file-hash', chunks),
      hash: MediaIntegrityService.hashBytes(new Uint8Array([30, 99])),
    };

    const report = service.inspectMedia(media, chunks);

    expect(report).toMatchObject({
      available: false,
      complete: true,
      fileHashValid: false,
    });
    expect(report.fileData).toBeUndefined();
  });
});

function createChunks(mediaObjectId: string, parts: Uint8Array[]): MediaChunkData[] {
  return parts.map((bytes, position) =>
    MediaChunk.create(mediaObjectId, position, bytes, peerId).getData(),
  );
}

function createDescriptor(
  mediaObjectId: string,
  chunks: readonly MediaChunkData[],
): MediaIntegrityDescriptor {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.size, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk.chunkData, offset);
    offset += chunk.chunkData.length;
  }
  return {
    id: mediaObjectId,
    size: bytes.length,
    hash: MediaIntegrityService.hashBytes(bytes),
    chunks: chunks.map((chunk) => chunk.id),
  };
}
