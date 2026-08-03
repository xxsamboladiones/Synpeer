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

  it('removes a corrupt chunk even when its media object is still referenced', async () => {
    const validChunk = createChunk('media_corrupt', 0, [1, 2, 3]);
    const corruptChunk = { ...validChunk, chunkData: new Uint8Array([9, 2, 3]) };
    const mediaObjects = createMediaObjectRepository([
      createMediaObject('media_corrupt', [validChunk], 1),
    ]);
    const chunks = createMediaChunkRepository([corruptChunk]);
    const posts = createPostRepository([createPost('post-corrupt', 'media_corrupt')]);
    const service = new MediaCacheCleanupService(posts, mediaObjects, chunks);

    const result = await service.cleanup();

    expect(result).toMatchObject({
      protectedMediaObjects: 1,
      deletedMediaObjects: 0,
      deletedChunks: 1,
      freedBytes: 3,
      remainingBytes: 0,
    });
    await expect(mediaObjects.getById('media_corrupt')).resolves.toBeTruthy();
  });

  it('preserves valid chunks when the persisted manifest is sorted lexically', async () => {
    const mediaId = 'media_canonical_manifest';
    const canonicalChunks = Array.from({ length: 11 }, (_, position) =>
      createChunk(mediaId, position, [position]),
    );
    const mediaObject = createMediaObject(mediaId, canonicalChunks, 1);
    const mediaObjects = createMediaObjectRepository([
      { ...mediaObject, chunks: [...mediaObject.chunks].sort() },
    ]);
    const chunks = createMediaChunkRepository(canonicalChunks);
    const posts = createPostRepository([createPost('post-canonical-manifest', mediaId)]);
    const service = new MediaCacheCleanupService(posts, mediaObjects, chunks);

    const result = await service.cleanup();

    expect(result.deletedChunks).toBe(0);
    await expect(chunks.getByMediaObjectId(mediaId)).resolves.toHaveLength(11);
  });

  it('preserves recoverable chunks when the media manifest is invalid', async () => {
    const mediaId = 'media-invalid-manifest';
    const validChunks = [createChunk(mediaId, 0, [1, 2]), createChunk(mediaId, 1, [3, 4])];
    const mediaObject = createMediaObject(mediaId, validChunks, 1);
    const mediaObjects = createMediaObjectRepository([
      { ...mediaObject, chunks: [validChunks[0].id, validChunks[0].id] },
    ]);
    const chunks = createMediaChunkRepository(validChunks);
    const posts = createPostRepository([createPost('post-invalid-manifest', mediaId)]);
    const service = new MediaCacheCleanupService(posts, mediaObjects, chunks);

    const result = await service.cleanup();

    expect(result.deletedChunks).toBe(0);
    await expect(chunks.getByMediaObjectId(mediaId)).resolves.toHaveLength(2);
  });

  it('preserves recoverable chunks when the media manifest is empty', async () => {
    const mediaId = 'media-empty-manifest';
    const validChunks = [createChunk(mediaId, 0, [1, 2])];
    const mediaObject = createMediaObject(mediaId, validChunks, 1);
    const mediaObjects = createMediaObjectRepository([{ ...mediaObject, chunks: [] }]);
    const chunks = createMediaChunkRepository(validChunks);
    const posts = createPostRepository([createPost('post-empty-manifest', mediaId)]);
    const service = new MediaCacheCleanupService(posts, mediaObjects, chunks);

    const result = await service.cleanup();

    expect(result.deletedChunks).toBe(0);
    await expect(chunks.getByMediaObjectId(mediaId)).resolves.toHaveLength(1);
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

  it('protects local uploads and active downloads even when they are not referenced', async () => {
    const localChunks = [createChunk('media_local', 0, [1, 2])];
    const activeChunks = [createChunk('media_active', 0, [3, 4])];
    const mediaObjects = createMediaObjectRepository([
      createMediaObject('media_local', localChunks, 1, 'peer-local' as PeerId),
      createMediaObject('media_active', activeChunks, 2, 'peer-remote' as PeerId),
    ]);
    const chunks = createMediaChunkRepository([...localChunks, ...activeChunks]);
    const service = new MediaCacheCleanupService(createPostRepository([]), mediaObjects, chunks, {
      localPeerId: 'peer-local' as PeerId,
      downloadRepository: createRetentionRepository({ activeMediaId: 'media_active' }),
    });

    const result = await service.cleanup();

    expect(result).toMatchObject({
      protectedMediaObjects: 2,
      protectedByActiveDownload: 1,
      deletedMediaObjects: 0,
      remainingBytes: 4,
    });
  });

  it('protects recently opened media using the persisted access timestamp', async () => {
    const recentChunks = [createChunk('media_recent', 0, [1, 2])];
    const mediaObjects = createMediaObjectRepository([
      createMediaObject('media_recent', recentChunks, 1, 'peer-remote' as PeerId),
    ]);
    const chunks = createMediaChunkRepository(recentChunks);
    const service = new MediaCacheCleanupService(createPostRepository([]), mediaObjects, chunks, {
      now: () => 10_000,
      recentAccessProtectionMs: 1_000,
      downloadRepository: createRetentionRepository({
        access: {
          mediaObjectId: 'media_recent',
          protected: false,
          lastAccessedAt: 9_500,
          updatedAt: 9_500,
        },
      }),
    });

    const result = await service.cleanup();

    expect(result).toMatchObject({
      protectedByRecentAccess: 1,
      deletedMediaObjects: 0,
      remainingBytes: 2,
    });
  });

  it('evicts an externally replicated object before the last known local replica', async () => {
    const replicatedChunks = [createChunk('media_replicated', 0, [1, 2])];
    const uniqueChunks = [createChunk('media_unique', 0, [3, 4])];
    const mediaObjects = createMediaObjectRepository([
      createMediaObject('media_replicated', replicatedChunks, 1, 'peer-remote' as PeerId),
      createMediaObject('media_unique', uniqueChunks, 2, 'peer-remote' as PeerId),
    ]);
    const chunks = createMediaChunkRepository([...replicatedChunks, ...uniqueChunks]);
    const posts = createPostRepository([
      createPost('post-replicated', 'media_replicated'),
      createPost('post-unique', 'media_unique'),
    ]);
    const service = new MediaCacheCleanupService(posts, mediaObjects, chunks, {
      maxBytes: 2,
      downloadRepository: createRetentionRepository({ replicatedMediaId: 'media_replicated' }),
    });

    const result = await service.cleanup();

    expect(result).toMatchObject({
      protectedAsLastKnownReplica: 1,
      deletedMediaObjects: 1,
      freedBytes: 2,
      remainingBytes: 2,
    });
    await expect(mediaObjects.getById('media_replicated')).resolves.toBeNull();
    await expect(mediaObjects.getById('media_unique')).resolves.toBeTruthy();
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
  author: PeerId = 'peer-a' as PeerId,
): MediaObjectData {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.size, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk.chunkData, offset);
    offset += chunk.chunkData.length;
  }
  return {
    id: mediaObjectId,
    author,
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

function createRetentionRepository(
  options: {
    activeMediaId?: string;
    replicatedMediaId?: string;
    access?: {
      mediaObjectId: string;
      protected: boolean;
      lastAccessedAt: number;
      updatedAt: number;
    };
  } = {},
) {
  return {
    findCompleteReplicaPeers: (mediaObjectId: string) =>
      mediaObjectId === options.replicatedMediaId ? (['peer-copy'] as PeerId[]) : [],
    getMediaAccess: (mediaObjectId: string) =>
      options.access?.mediaObjectId === mediaObjectId ? options.access : null,
    getState: (mediaObjectId: string) =>
      mediaObjectId === options.activeMediaId
        ? {
            mediaObjectId,
            status: 'downloading' as const,
            totalChunks: 1,
            downloadedChunks: 0,
            requestedChunks: 0,
            failedChunks: 0,
            candidatePeers: [],
            updatedAt: 1,
          }
        : null,
    pruneExpiredAnnouncements: async () => 0,
    removeMediaAccess: async () => undefined,
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
