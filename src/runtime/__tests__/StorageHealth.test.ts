import type { MediaChunkData } from '@/models/MediaChunk';
import type { MediaObjectData } from '@/models/MediaObject';
import type { PostData } from '@/models/Post';
import type { PeerId } from '@/network/NetworkTypes';

import { createStorageHealthSnapshot } from '../StorageHealth';

describe('StorageHealth', () => {
  it('derives storage totals and media protection from repositories', () => {
    const mediaObjects = [
      createMediaObject('media-protected', ['chunk-a'], 'image'),
      createMediaObject('media-orphan', ['chunk-b'], 'video'),
      createMediaObject('media-partial', ['chunk-c', 'chunk-d'], 'audio'),
    ];
    const chunks = [
      createChunk('chunk-a', 'media-protected', 100),
      createChunk('chunk-b', 'media-orphan', 200),
      createChunk('chunk-c', 'media-partial', 300),
      createChunk('chunk-orphan', 'missing-media', 400),
    ];
    const posts = [createPost('media-protected')];

    const snapshot = createStorageHealthSnapshot({
      distributedStorageBytes: 10,
      totalKeys: 2,
      replicatedKeys: 1,
      mediaObjects,
      chunks,
      posts,
      activeDownloads: 1,
    });

    expect(snapshot.totalUsedBytes).toBe(1010);
    expect(snapshot.replicatedKeys).toBe(1);
    expect(snapshot.mediaChunkBytes).toBe(1000);
    expect(snapshot.mediaObjects).toBe(3);
    expect(snapshot.completeMediaObjects).toBe(2);
    expect(snapshot.protectedMediaObjects).toBe(1);
    expect(snapshot.orphanMediaObjects).toBe(2);
    expect(snapshot.orphanChunks).toBe(1);
    expect(snapshot.averageChunkBytes).toBe(250);
    expect(snapshot.mediaByType).toMatchObject({ image: 1, video: 1, audio: 1, document: 0 });
  });
});

function createMediaObject(
  id: string,
  chunks: string[],
  type: MediaObjectData['type'],
): MediaObjectData {
  return {
    id,
    author: 'peer-a' as PeerId,
    createdAt: 1,
    updatedAt: 1,
    signature: 'signature',
    version: '1.0',
    type,
    mime: 'application/octet-stream',
    size: 1,
    hash: 'hash',
    chunks,
  };
}

function createChunk(id: string, mediaObjectId: string, size: number): MediaChunkData {
  return {
    id,
    author: 'peer-a' as PeerId,
    createdAt: 1,
    updatedAt: 1,
    signature: 'signature',
    version: '1.0',
    mediaObjectId,
    position: 0,
    size,
    hash: 'hash',
    chunkData: new Uint8Array(size),
  };
}

function createPost(mediaObjectId: string): PostData {
  return {
    id: 'post-a',
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
