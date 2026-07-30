import type { MediaChunkData } from '../../../models/MediaChunk';
import type { MediaObjectData } from '../../../models/MediaObject';
import type { MediaChunkRepository } from '../../../repositories/MediaChunkRepository';
import type { MediaObjectRepository } from '../../../repositories/MediaObjectRepository';
import { MediaService } from '../MediaService';

function createMediaObjectRepository() {
  const mediaObjects = new Map<string, MediaObjectData>();

  return {
    create: async (mediaObject: MediaObjectData) => {
      mediaObjects.set(mediaObject.id, mediaObject);
    },
    getById: async (id: string) => mediaObjects.get(id) ?? null,
    getByAuthor: async (author: string) =>
      [...mediaObjects.values()].filter((mediaObject) => mediaObject.author === author),
    getByType: async (type: string) =>
      [...mediaObjects.values()].filter((mediaObject) => mediaObject.type === type),
    getByHash: async (hash: string) =>
      [...mediaObjects.values()].find((mediaObject) => mediaObject.hash === hash) ?? null,
    update: async (mediaObject: MediaObjectData) => {
      mediaObjects.set(mediaObject.id, mediaObject);
    },
    delete: async (id: string) => {
      mediaObjects.delete(id);
    },
    getAll: async () => [...mediaObjects.values()],
    getCount: async () => mediaObjects.size,
    getCountByType: async (type: string) =>
      [...mediaObjects.values()].filter((mediaObject) => mediaObject.type === type).length,
  } as unknown as MediaObjectRepository;
}

function createMediaChunkRepository() {
  const chunks = new Map<string, MediaChunkData>();

  return {
    create: async (chunk: MediaChunkData) => {
      if (
        ![...chunks.values()].some(
          (stored) =>
            stored.mediaObjectId === chunk.mediaObjectId && stored.position === chunk.position,
        )
      ) {
        chunks.set(chunk.id, chunk);
      }
    },
    getById: async (id: string) => chunks.get(id) ?? null,
    getByMediaObjectId: async (mediaObjectId: string) =>
      [...chunks.values()]
        .filter((chunk) => chunk.mediaObjectId === mediaObjectId)
        .sort((first, second) => first.position - second.position),
    getByPosition: async (mediaObjectId: string, position: number) =>
      [...chunks.values()].find(
        (chunk) => chunk.mediaObjectId === mediaObjectId && chunk.position === position,
      ) ?? null,
    getByHash: async (hash: string) =>
      [...chunks.values()].find((chunk) => chunk.hash === hash) ?? null,
    update: async (chunk: MediaChunkData) => {
      chunks.set(chunk.id, chunk);
    },
    delete: async (id: string) => {
      chunks.delete(id);
    },
    deleteByMediaObjectId: async (mediaObjectId: string) => {
      for (const chunk of chunks.values()) {
        if (chunk.mediaObjectId === mediaObjectId) {
          chunks.delete(chunk.id);
        }
      }
    },
    getCountByMediaObjectId: async (mediaObjectId: string) =>
      [...chunks.values()].filter((chunk) => chunk.mediaObjectId === mediaObjectId).length,
    getTotalCount: async () => chunks.size,
    getTotalStorageSize: async () =>
      [...chunks.values()].reduce((total, chunk) => total + chunk.size, 0),
  } as unknown as MediaChunkRepository;
}

function createService() {
  const mediaObjectRepository = createMediaObjectRepository();
  const mediaChunkRepository = createMediaChunkRepository();
  const service = new MediaService(mediaObjectRepository, mediaChunkRepository, {
    defaultChunkSize: 4,
  });

  return { service, mediaObjectRepository, mediaChunkRepository };
}

describe('MediaService', () => {
  it('ingests media into deterministic local chunks tied to the final media object', async () => {
    const { service, mediaChunkRepository } = createService();
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const first = await service.uploadMedia('alice', 'image', 'image/png', data);
    const second = await service.uploadMedia('alice', 'image', 'image/png', data);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(first.mediaObject?.hash).toBe(second.mediaObject?.hash);
    expect(first.mediaObject?.id).toBe(second.mediaObject?.id);
    expect(first.mediaObject?.chunks).toHaveLength(3);

    const chunks = await mediaChunkRepository.getByMediaObjectId(first.mediaObject!.id);
    expect(chunks.map((chunk) => chunk.mediaObjectId)).toEqual([
      first.mediaObject!.id,
      first.mediaObject!.id,
      first.mediaObject!.id,
    ]);
    expect(chunks.map((chunk) => chunk.id)).toEqual(second.mediaObject?.chunks);
  });

  it('reassembles media bytes independently of chunk arrival order', async () => {
    const { service, mediaChunkRepository } = createService();
    const data = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90]);
    const upload = await service.uploadMedia('alice', 'document', 'application/octet-stream', data);
    const chunks = await mediaChunkRepository.getByMediaObjectId(upload.mediaObject!.id);

    const reassembled = service.reassembleChunksForTest([chunks[2], chunks[0], chunks[1]]);

    expect(Array.from(reassembled)).toEqual(Array.from(data));
  });

  it('returns validated local media bytes for generic binary files', async () => {
    const { service } = createService();
    const data = new Uint8Array([77, 90, 144, 0, 3, 0, 0, 0]);

    const upload = await service.uploadMedia(
      'alice',
      'document',
      'application/vnd.microsoft.portable-executable',
      data,
    );
    const localBytes = await service.getLocalMediaBytes(upload.mediaObject!.id);

    expect(localBytes.success).toBe(true);
    expect(localBytes.mediaObject).toMatchObject({
      type: 'document',
      mime: 'application/vnd.microsoft.portable-executable',
    });
    expect(Array.from(localBytes.fileData ?? [])).toEqual(Array.from(data));
  });

  it('accepts video media objects even when duration metadata is unavailable', async () => {
    const { service } = createService();
    const data = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);

    const upload = await service.uploadMedia('alice', 'video', 'video/mp4', data);

    expect(upload.success).toBe(true);
    expect(upload.mediaObject).toMatchObject({
      type: 'video',
      duration: undefined,
    });
  });

  it('rejects corrupted chunks during file validation', async () => {
    const { service, mediaChunkRepository } = createService();
    const data = new Uint8Array([1, 1, 2, 3, 5, 8]);
    const upload = await service.uploadMedia('alice', 'document', 'application/octet-stream', data);
    const chunks = await mediaChunkRepository.getByMediaObjectId(upload.mediaObject!.id);
    const corrupted = [{ ...chunks[0], chunkData: new Uint8Array([9, 9, 9]) }, ...chunks.slice(1)];

    expect(service.validateFileForTest(upload.mediaObject!, corrupted)).toBe(false);
  });
});
