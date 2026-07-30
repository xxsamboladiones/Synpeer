import { MediaChunk, type MediaChunkData } from '@/models/MediaChunk';
import type { MediaObjectData } from '@/models/MediaObject';
import type { PostData } from '@/models/Post';
import type { PeerId } from '@/network/NetworkTypes';
import { sha256Hex } from '@/utils/hash';

import { MediaCacheCleanupService } from '../MediaCacheCleanupService';

describe('MediaCacheCleanupService', () => {
  it('preserves media referenced by posts and removes unreferenced media with chunks', async () => {
    const protectedChunks = [createChunk('media_protected', 0, [1, 2])];
    const orphanChunks = [createChunk('media_orphan', 0, [3, 4, 5])];
    const mediaObjects = createMediaObjectRepository([
      createMediaObject('media_protected', protectedChunks, 10),
      createMediaObject('media_orphan', orphanChunks, 1),
    ]);
    const chunks = createMediaChunkRepository([...protectedChunks, ...orphanChunks]);
    const posts = createPostRepository([createPost('post-1', 'media_protected')]);
    const service = new MediaCacheCleanupService(posts, mediaObjects, chunks);

    const result = await service.cleanup();

    expect(result).toMatchObject({
      protectedMediaObjects: 1,
      deletedMediaObjects: 1,
      deletedChunks: 1,
      freedBytes: 3,
      remainingBytes: 2,
    });
    await expect(mediaObjects.getById('media_protected')).resolves.toBeTruthy();
    await expect(mediaObjects.getById('media_orphan')).resolves.toBeNull();
    await expect(chunks.getByMediaObjectId('media_protected')).resolves.toHaveLength(1);
    await expect(chunks.getByMediaObjectId('media_orphan')).resolves.toHaveLength(0);
  });

  it('removes chunks whose media object no longer exists', async () => {
    const orphanChunk = createChunk('missing_media', 0, [9, 9, 9]);
    const mediaObjects = createMediaObjectRepository([]);
    const chunks = createMediaChunkRepository([orphanChunk]);
    const posts = createPostRepository([]);
    const service = new MediaCacheCleanupService(posts, mediaObjects, chunks);

    const result = await service.cleanup();

    expect(result).toMatchObject({
      deletedMediaObjects: 0,
      deletedChunks: 1,
      freedBytes: 3,
      remainingBytes: 0,
    });
    await expect(chunks.getByMediaObjectId('missing_media')).resolves.toHaveLength(0);
  });

  it('does not delete protected media even when it exceeds the configured size limit', async () => {
    const protectedChunks = [createChunk('media_protected_large', 0, [1, 2, 3, 4])];
    const mediaObjects = createMediaObjectRepository([
      createMediaObject('media_protected_large', protectedChunks, 1),
    ]);
    const chunks = createMediaChunkRepository(protectedChunks);
    const posts = createPostRepository([createPost('post-1', 'media_protected_large')]);
    const service = new MediaCacheCleanupService(posts, mediaObjects, chunks, { maxBytes: 1 });

    const result = await service.cleanup();

    expect(result).toMatchObject({
      protectedMediaObjects: 1,
      deletedMediaObjects: 0,
      deletedChunks: 0,
      freedBytes: 0,
      remainingBytes: 4,
    });
  });
});

function createChunk(mediaObjectId: string, position: number, bytes: number[]): MediaChunkData {
  return MediaChunk.create(
    mediaObjectId,
    position,
    new Uint8Array(bytes),
    'peer-a' as PeerId,
  ).getData();
}

function createMediaObject(
  mediaObjectId: string,
  chunks: MediaChunkData[],
  updatedAt: number,
): MediaObjectData {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.size, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk.chunkData, offset);
    offset += chunk.chunkData.length;
  }
  return {
    id: mediaObjectId,
    author: 'peer-a' as PeerId,
    createdAt: updatedAt,
    updatedAt,
    signature: 'signature',
    version: '1.0',
    type: 'image',
    mime: 'image/png',
    size: bytes.length,
    hash: sha256Hex(bytes),
    chunks: chunks.map((chunk) => chunk.id),
  };
}

function createPost(postId: string, mediaObjectId: string): PostData {
  return {
    id: postId,
    author: 'peer-a' as PeerId,
    createdAt: 1,
    updatedAt: 1,
    signature: 'signature',
    version: '2.0.0',
    text: 'post',
    contentHash: 'hash',
    mediaAttachments: [
      {
        id: mediaObjectId,
        type: 'image',
        mime: 'image/png',
        size: 1,
        hash: 'hash',
        chunks: [],
      },
    ],
    deleted: false,
  };
}

function createPostRepository(initial: PostData[]) {
  const posts = [...initial];
  return {
    getAll: async (limit = 50, offset = 0) => posts.slice(offset, offset + limit),
  };
}

function createMediaObjectRepository(initial: MediaObjectData[]) {
  const mediaObjects = new Map(initial.map((mediaObject) => [mediaObject.id, mediaObject]));
  return {
    getAll: async (limit = 50, offset = 0) =>
      [...mediaObjects.values()].slice(offset, offset + limit),
    getById: async (id: string) => mediaObjects.get(id) ?? null,
    delete: async (id: string) => {
      mediaObjects.delete(id);
    },
  };
}

function createMediaChunkRepository(initial: MediaChunkData[]) {
  const chunks = new Map(initial.map((chunk) => [chunk.id, chunk]));
  return {
    getAll: async () => [...chunks.values()],
    getByMediaObjectId: async (mediaObjectId: string) =>
      [...chunks.values()].filter((chunk) => chunk.mediaObjectId === mediaObjectId),
    delete: async (id: string) => {
      chunks.delete(id);
    },
    deleteByMediaObjectId: async (mediaObjectId: string) => {
      for (const chunk of [...chunks.values()]) {
        if (chunk.mediaObjectId === mediaObjectId) {
          chunks.delete(chunk.id);
        }
      }
    },
    getTotalStorageSize: async () =>
      [...chunks.values()].reduce((total, chunk) => total + chunk.size, 0),
  };
}
