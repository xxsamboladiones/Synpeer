import type { MediaChunkData } from '@/models/MediaChunk';
import { MediaChunk } from '@/models/MediaChunk';
import type { MediaObjectData } from '@/models/MediaObject';
import type { PostData } from '@/models/Post';
import { estimateNetworkMessageBytes } from '@/network/NetworkMessage';
import { InMemoryPeerTransport } from '@/network/PeerTransport';
import type { PeerId } from '@/network/NetworkTypes';
import type { MediaChunkRepository } from '@/repositories/MediaChunkRepository';
import type { MediaObjectRepository } from '@/repositories/MediaObjectRepository';
import { createStorageService } from '@/services/storage/StorageService';
import { sha256Hex } from '@/utils/hash';
import { openDatabaseService } from '@/database/sqliteAdapter.web';

import type { MediaAvailabilityCrypto } from '../MediaAvailability';
import { MediaAvailabilityService } from '../MediaAvailabilityService';
import { MediaDownloadRepository } from '../MediaDownloadRepository';
import { MediaIntegrityService } from '../MediaIntegrityService';
import { PeerMediaSyncService, type PeerMediaSyncOptions } from '../PeerMediaSyncService';
import { MediaSourceSelector } from '../MediaSourceSelector';

function createMediaObjectRepository(initial: MediaObjectData[] = []): MediaObjectRepository {
  const mediaObjects = new Map(initial.map((mediaObject) => [mediaObject.id, mediaObject]));
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

function createMediaChunkRepository(initial: MediaChunkData[] = []): MediaChunkRepository {
  const chunks = new Map(initial.map((chunk) => [chunk.id, chunk]));
  return {
    create: async (chunk: MediaChunkData) => {
      chunks.set(chunk.id, chunk);
    },
    getById: async (id: string) => chunks.get(id) ?? null,
    getByMediaObjectId: async (mediaObjectId: string) =>
      [...chunks.values()]
        .filter((chunk) => chunk.mediaObjectId === mediaObjectId)
        .sort((left, right) => left.position - right.position),
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

describe('PeerMediaSyncService', () => {
  it('downloads missing post attachment chunks from the peer that delivered the post', async () => {
    const mediaObjectId = 'media_image_hash';
    const chunks = [
      MediaChunk.create(mediaObjectId, 0, new Uint8Array([1, 2, 3]), 'peer-a').getData(),
      MediaChunk.create(mediaObjectId, 1, new Uint8Array([4, 5, 6]), 'peer-a').getData(),
    ];
    const post = createPostWithAttachment(mediaObjectId, chunks);
    const transportA = new InMemoryPeerTransport('peer-a' as PeerId);
    const transportB = new InMemoryPeerTransport('peer-b' as PeerId);
    await transportA.connect(transportB);

    const serviceA = new PeerMediaSyncService(
      'peer-a' as PeerId,
      transportA,
      createMediaObjectRepository(),
      createMediaChunkRepository(chunks),
    );
    const mediaObjectsB = createMediaObjectRepository();
    const mediaChunksB = createMediaChunkRepository();
    const serviceB = new PeerMediaSyncService(
      'peer-b' as PeerId,
      transportB,
      mediaObjectsB,
      mediaChunksB,
    );
    serviceA.start();
    serviceB.start();

    const result = await serviceB.ensurePostMediaAvailable(post, 'peer-a' as PeerId);

    expect(result).toEqual({ requested: 2, received: 2, skipped: 0, failed: 0 });
    expect(serviceB.getDownloadState(mediaObjectId)).toMatchObject({
      status: 'available',
      totalChunks: 2,
      downloadedChunks: 2,
      requestedChunks: 2,
      failedChunks: 0,
      candidatePeers: ['peer-a'],
    });
    await expect(mediaObjectsB.getById(mediaObjectId)).resolves.toMatchObject({
      id: mediaObjectId,
      hash: post.mediaAttachments?.[0]?.hash,
    });
    await expect(mediaChunksB.getByMediaObjectId(mediaObjectId)).resolves.toHaveLength(2);

    serviceA.stop();
    serviceB.stop();
  });

  it('splits oversized chunk responses into smaller transfer parts', async () => {
    const mediaObjectId = 'media_large_chunk_hash';
    const bytes = new Uint8Array(212501);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 251;
    }
    const chunks = [MediaChunk.create(mediaObjectId, 0, bytes, 'peer-a' as PeerId).getData()];
    const post = createPostWithAttachment(mediaObjectId, chunks);
    const transportA = new InMemoryPeerTransport('peer-a' as PeerId);
    const transportB = new InMemoryPeerTransport('peer-b' as PeerId);
    await transportA.connect(transportB);
    const frameLimit = 24 * 1024;
    const partFrameBytes: number[] = [];
    const unsubscribeFrameInspection = transportB.subscribe((message) => {
      if (message.messageType === 'media.chunk.part') {
        partFrameBytes.push(estimateNetworkMessageBytes(message));
      }
    });

    const serviceA = new PeerMediaSyncService(
      'peer-a' as PeerId,
      transportA,
      createMediaObjectRepository(),
      createMediaChunkRepository(chunks),
      undefined,
      { maxFrameBytes: frameLimit },
    );
    const mediaChunksB = createMediaChunkRepository();
    const serviceB = new PeerMediaSyncService(
      'peer-b' as PeerId,
      transportB,
      createMediaObjectRepository(),
      mediaChunksB,
    );
    serviceA.start();
    serviceB.start();

    const result = await serviceB.ensurePostMediaAvailable(post, 'peer-a' as PeerId);

    expect(result).toEqual({ requested: 1, received: 1, skipped: 0, failed: 0 });
    await expect(mediaChunksB.getById(chunks[0].id)).resolves.toMatchObject({
      id: chunks[0].id,
      size: bytes.length,
      hash: chunks[0].hash,
    });
    await expect(mediaChunksB.getByMediaObjectId(mediaObjectId)).resolves.toHaveLength(1);
    expect(serviceB.getDownloadState(mediaObjectId)).toMatchObject({ status: 'available' });
    expect(partFrameBytes.length).toBeGreaterThan(1);
    expect(Math.max(...partFrameBytes)).toBeLessThanOrEqual(frameLimit);

    unsubscribeFrameInspection();
    serviceA.stop();
    serviceB.stop();
  });

  it('rejects multipart transfers that exceed the configured part limit', async () => {
    const mediaObjectId = 'media_part_limit';
    const bytes = new Uint8Array(212501).fill(7);
    const chunks = [MediaChunk.create(mediaObjectId, 0, bytes, 'peer-a' as PeerId).getData()];
    const post = createPostWithAttachment(mediaObjectId, chunks);
    const transportA = new InMemoryPeerTransport('peer-a' as PeerId);
    const transportB = new InMemoryPeerTransport('peer-b' as PeerId);
    await transportA.connect(transportB);

    const serviceA = new PeerMediaSyncService(
      'peer-a' as PeerId,
      transportA,
      createMediaObjectRepository(),
      createMediaChunkRepository(chunks),
    );
    const mediaChunksB = createMediaChunkRepository();
    const serviceB = new PeerMediaSyncService(
      'peer-b' as PeerId,
      transportB,
      createMediaObjectRepository(),
      mediaChunksB,
      undefined,
      {
        maxAttemptsPerChunk: 1,
        maxPendingPartsPerMessage: 1,
        requestTimeoutMs: 100,
      },
    );
    serviceA.start();
    serviceB.start();

    const result = await serviceB.ensurePostMediaAvailable(post, 'peer-a' as PeerId);

    expect(result).toEqual({ requested: 1, received: 0, skipped: 0, failed: 1 });
    await expect(mediaChunksB.getByMediaObjectId(mediaObjectId)).resolves.toEqual([]);

    serviceA.stop();
    serviceB.stop();
  });

  it('rejects media when all chunks arrive but the full file hash does not match', async () => {
    const mediaObjectId = 'media_bad_file_hash';
    const chunks = [
      MediaChunk.create(mediaObjectId, 0, new Uint8Array([1, 2, 3]), 'peer-a').getData(),
      MediaChunk.create(mediaObjectId, 1, new Uint8Array([4, 5, 6]), 'peer-a').getData(),
    ];
    const post = createPostWithAttachment(mediaObjectId, chunks);
    const corruptedPost: PostData = {
      ...post,
      mediaAttachments: post.mediaAttachments?.map((attachment) => ({
        ...attachment,
        hash: 'not-the-real-file-hash',
      })),
    };
    const transportA = new InMemoryPeerTransport('peer-a' as PeerId);
    const transportB = new InMemoryPeerTransport('peer-b' as PeerId);
    await transportA.connect(transportB);

    const serviceA = new PeerMediaSyncService(
      'peer-a' as PeerId,
      transportA,
      createMediaObjectRepository(),
      createMediaChunkRepository(chunks),
    );
    const serviceB = new PeerMediaSyncService(
      'peer-b' as PeerId,
      transportB,
      createMediaObjectRepository(),
      createMediaChunkRepository(),
    );
    serviceA.start();
    serviceB.start();

    const result = await serviceB.ensurePostMediaAvailable(corruptedPost, 'peer-a' as PeerId);

    expect(result).toEqual({ requested: 2, received: 2, skipped: 0, failed: 1 });
    expect(serviceB.getDownloadState(mediaObjectId)).toMatchObject({
      status: 'failed',
      downloadedChunks: 2,
      failedChunks: 1,
      error: 'Media failed final integrity validation',
    });

    serviceA.stop();
    serviceB.stop();
  });

  it('downloads multiple missing chunks through the concurrent chunk path', async () => {
    const mediaObjectId = 'media_parallel_hash';
    const chunks = [
      MediaChunk.create(mediaObjectId, 0, new Uint8Array([1]), 'peer-a').getData(),
      MediaChunk.create(mediaObjectId, 1, new Uint8Array([2]), 'peer-a').getData(),
      MediaChunk.create(mediaObjectId, 2, new Uint8Array([3]), 'peer-a').getData(),
      MediaChunk.create(mediaObjectId, 3, new Uint8Array([4]), 'peer-a').getData(),
    ];
    const post = createPostWithAttachment(mediaObjectId, chunks);
    const transportA = new InMemoryPeerTransport('peer-a' as PeerId);
    const transportB = new InMemoryPeerTransport('peer-b' as PeerId);
    await transportA.connect(transportB);
    const mediaChunksB = createMediaChunkRepository();

    const serviceA = new PeerMediaSyncService(
      'peer-a' as PeerId,
      transportA,
      createMediaObjectRepository(),
      createMediaChunkRepository(chunks),
    );
    const serviceB = new PeerMediaSyncService(
      'peer-b' as PeerId,
      transportB,
      createMediaObjectRepository(),
      mediaChunksB,
      undefined,
      { maxConcurrentChunks: 2 },
    );
    serviceA.start();
    serviceB.start();

    const result = await serviceB.ensurePostMediaAvailable(post, 'peer-a' as PeerId);

    expect(result).toEqual({ requested: 4, received: 4, skipped: 0, failed: 0 });
    await expect(mediaChunksB.getByMediaObjectId(mediaObjectId)).resolves.toHaveLength(4);
    expect(serviceB.getDownloadState(mediaObjectId)).toMatchObject({ status: 'available' });

    serviceA.stop();
    serviceB.stop();
  });

  it('falls back to another connected peer when the source peer does not have the chunk', async () => {
    const mediaObjectId = 'media_image_hash';
    const chunks = [
      MediaChunk.create(mediaObjectId, 0, new Uint8Array([7, 8, 9]), 'peer-c').getData(),
    ];
    const post = createPostWithAttachment(mediaObjectId, chunks);
    const transportA = new InMemoryPeerTransport('peer-a' as PeerId);
    const transportB = new InMemoryPeerTransport('peer-b' as PeerId);
    const transportC = new InMemoryPeerTransport('peer-c' as PeerId);
    await transportA.connect(transportB);
    await transportB.connect(transportC);

    const serviceA = new PeerMediaSyncService(
      'peer-a' as PeerId,
      transportA,
      createMediaObjectRepository(),
      createMediaChunkRepository(),
      undefined,
      { requestTimeoutMs: 1, maxAttemptsPerChunk: 1 },
    );
    const serviceC = new PeerMediaSyncService(
      'peer-c' as PeerId,
      transportC,
      createMediaObjectRepository(),
      createMediaChunkRepository(chunks),
    );
    const mediaChunksB = createMediaChunkRepository();
    const serviceB = new PeerMediaSyncService(
      'peer-b' as PeerId,
      transportB,
      createMediaObjectRepository(),
      mediaChunksB,
      undefined,
      { requestTimeoutMs: 1, maxAttemptsPerChunk: 1 },
    );
    serviceA.start();
    serviceB.start();
    serviceC.start();

    const result = await serviceB.ensurePostMediaAvailable(post, 'peer-a' as PeerId);

    expect(result).toEqual({ requested: 1, received: 1, skipped: 0, failed: 0 });
    await expect(mediaChunksB.getByMediaObjectId(mediaObjectId)).resolves.toHaveLength(1);
    expect(serviceB.getDownloadState(mediaObjectId)).toMatchObject({
      status: 'available',
      candidatePeers: ['peer-a', 'peer-c'],
    });

    serviceA.stop();
    serviceB.stop();
    serviceC.stop();
  });

  it('quarantines a corrupt replica and completes the chunk from a healthy peer', async () => {
    const mediaObjectId = 'media_corrupt_replica_hash';
    const chunks = [
      MediaChunk.create(mediaObjectId, 0, new Uint8Array([7, 8, 9]), 'peer-c').getData(),
    ];
    const post = createPostWithAttachment(mediaObjectId, chunks);
    const transportA = new InMemoryPeerTransport('peer-a' as PeerId);
    const transportB = new InMemoryPeerTransport('peer-b' as PeerId);
    const transportC = new InMemoryPeerTransport('peer-c' as PeerId);
    await transportA.connect(transportB);
    await transportB.connect(transportC);
    const maliciousUnsubscribe = transportA.subscribe(async (message, connection) => {
      if (message.messageType !== 'media.chunk.request') {
        return;
      }
      await connection.send(
        'media.chunk.response',
        {
          version: 1,
          type: 'media.chunk.response',
          chunk: {
            ...chunks[0],
            chunkData: undefined,
            chunkDataBase64: testBytesToBase64(new Uint8Array([9, 9, 9])),
          },
        },
        { correlationId: message.correlationId },
      );
    });
    const serviceC = new PeerMediaSyncService(
      'peer-c' as PeerId,
      transportC,
      createMediaObjectRepository(),
      createMediaChunkRepository(chunks),
    );
    const repositoryB = await createDownloadRepository();
    const mediaChunksB = createMediaChunkRepository();
    const serviceB = new PeerMediaSyncService(
      'peer-b' as PeerId,
      transportB,
      createMediaObjectRepository(),
      mediaChunksB,
      undefined,
      { requestTimeoutMs: 100, maxAttemptsPerChunk: 1 },
      repositoryB,
    );
    serviceB.start();
    serviceC.start();

    const result = await serviceB.ensurePostMediaAvailable(post, 'peer-a' as PeerId);

    expect(result).toEqual({ requested: 1, received: 1, skipped: 0, failed: 0 });
    expect(repositoryB.isReplicaQuarantined('peer-a' as PeerId, mediaObjectId, chunks[0].id)).toBe(
      true,
    );
    expect(
      repositoryB.getReplicaObservation('peer-a' as PeerId, mediaObjectId, chunks[0].id),
    ).toMatchObject({
      status: 'corrupt',
      failureCount: 1,
    });
    expect(
      repositoryB.getReplicaObservation('peer-c' as PeerId, mediaObjectId, chunks[0].id),
    ).toMatchObject({
      status: 'success',
      successCount: 1,
    });
    await expect(mediaChunksB.getByMediaObjectId(mediaObjectId)).resolves.toHaveLength(1);

    maliciousUnsubscribe();
    serviceB.stop();
    serviceC.stop();
  });

  it('backs off a peer after failed chunk requests and prefers healthy peers', async () => {
    const mediaObjectId = 'media_backoff_hash';
    const chunks = [
      MediaChunk.create(mediaObjectId, 0, new Uint8Array([10]), 'peer-c').getData(),
      MediaChunk.create(mediaObjectId, 1, new Uint8Array([11]), 'peer-c').getData(),
    ];
    const post = createPostWithAttachment(mediaObjectId, chunks);
    const transportA = new InMemoryPeerTransport('peer-a' as PeerId);
    const transportB = new InMemoryPeerTransport('peer-b' as PeerId);
    const transportC = new InMemoryPeerTransport('peer-c' as PeerId);
    await transportA.connect(transportB);
    await transportB.connect(transportC);

    const serviceA = new PeerMediaSyncService(
      'peer-a' as PeerId,
      transportA,
      createMediaObjectRepository(),
      createMediaChunkRepository(),
      undefined,
      { requestTimeoutMs: 1, maxAttemptsPerChunk: 1 },
    );
    const serviceC = new PeerMediaSyncService(
      'peer-c' as PeerId,
      transportC,
      createMediaObjectRepository(),
      createMediaChunkRepository(chunks),
    );
    const serviceB = new PeerMediaSyncService(
      'peer-b' as PeerId,
      transportB,
      createMediaObjectRepository(),
      createMediaChunkRepository(),
      undefined,
      {
        maxConcurrentChunks: 1,
        requestTimeoutMs: 1,
        maxAttemptsPerChunk: 1,
        peerFailureBackoffMs: 60000,
      },
    );
    serviceA.start();
    serviceB.start();
    serviceC.start();

    const result = await serviceB.ensurePostMediaAvailable(post, 'peer-a' as PeerId);

    expect(result).toEqual({ requested: 2, received: 2, skipped: 0, failed: 0 });
    expect(serviceB.getPeerTransferStats('peer-a' as PeerId)).toMatchObject({
      failures: 1,
      successes: 0,
    });
    expect(serviceB.getPeerTransferStats('peer-a' as PeerId).backoffUntil).toBeGreaterThan(
      Date.now(),
    );
    expect(serviceB.getPeerTransferStats('peer-c' as PeerId)).toMatchObject({
      failures: 0,
      successes: 2,
    });

    serviceA.stop();
    serviceB.stop();
    serviceC.stop();
  });

  it('records failed status when no connected peer can serve missing chunks', async () => {
    const mediaObjectId = 'media_missing_hash';
    const chunks = [MediaChunk.create(mediaObjectId, 0, new Uint8Array([1]), 'peer-a').getData()];
    const post = createPostWithAttachment(mediaObjectId, chunks);
    const transportA = new InMemoryPeerTransport('peer-a' as PeerId);
    const transportB = new InMemoryPeerTransport('peer-b' as PeerId);
    await transportA.connect(transportB);
    const serviceA = new PeerMediaSyncService(
      'peer-a' as PeerId,
      transportA,
      createMediaObjectRepository(),
      createMediaChunkRepository(),
      undefined,
      { requestTimeoutMs: 1, maxAttemptsPerChunk: 1 },
    );
    const serviceB = new PeerMediaSyncService(
      'peer-b' as PeerId,
      transportB,
      createMediaObjectRepository(),
      createMediaChunkRepository(),
      undefined,
      { requestTimeoutMs: 1, maxAttemptsPerChunk: 1 },
    );
    serviceA.start();
    serviceB.start();

    const result = await serviceB.ensurePostMediaAvailable(post, 'peer-a' as PeerId);

    expect(result).toEqual({ requested: 1, received: 0, skipped: 0, failed: 1 });
    expect(serviceB.getDownloadState(mediaObjectId)).toMatchObject({
      status: 'failed',
      totalChunks: 1,
      downloadedChunks: 0,
      failedChunks: 1,
    });

    serviceA.stop();
    serviceB.stop();
  });

  it('downloads oversized legacy chunks through split transfer parts', async () => {
    const mediaObjectId = 'media_oversized_legacy_chunk';
    const chunks = [
      MediaChunk.create(mediaObjectId, 0, new Uint8Array(300 * 1024).fill(1), 'peer-a').getData(),
    ];
    const post = createPostWithAttachment(mediaObjectId, chunks);
    const transportA = new InMemoryPeerTransport('peer-a' as PeerId);
    const transportB = new InMemoryPeerTransport('peer-b' as PeerId);
    await transportA.connect(transportB);

    const serviceA = new PeerMediaSyncService(
      'peer-a' as PeerId,
      transportA,
      createMediaObjectRepository(),
      createMediaChunkRepository(chunks),
    );
    const serviceB = new PeerMediaSyncService(
      'peer-b' as PeerId,
      transportB,
      createMediaObjectRepository(),
      createMediaChunkRepository(),
      undefined,
      { requestTimeoutMs: 1000, maxAttemptsPerChunk: 1 },
    );
    serviceA.start();
    serviceB.start();

    const result = await serviceB.ensurePostMediaAvailable(post, 'peer-a' as PeerId);

    expect(result).toEqual({ requested: 1, received: 1, skipped: 0, failed: 0 });
    expect(serviceB.getDownloadState(mediaObjectId)).toMatchObject({
      status: 'available',
      totalChunks: 1,
      downloadedChunks: 1,
      failedChunks: 0,
    });

    serviceA.stop();
    serviceB.stop();
  });

  it('announces local chunk availability to connected peers', async () => {
    const mediaObjectId = 'media_manifest_hash';
    const chunks = [
      MediaChunk.create(mediaObjectId, 0, new Uint8Array([9, 9]), 'peer-a').getData(),
    ];
    const mediaObject = createMediaObject(mediaObjectId, chunks, 'peer-a' as PeerId);
    const transportA = new InMemoryPeerTransport('peer-a' as PeerId);
    const transportB = new InMemoryPeerTransport('peer-b' as PeerId);
    await transportA.connect(transportB);

    const repositoryA = await createDownloadRepository();
    const repositoryB = await createDownloadRepository();
    const serviceA = createSignedMediaSyncService(
      'peer-a' as PeerId,
      transportA,
      createMediaObjectRepository([mediaObject]),
      createMediaChunkRepository(chunks),
      repositoryA,
    );
    const serviceB = createSignedMediaSyncService(
      'peer-b' as PeerId,
      transportB,
      createMediaObjectRepository(),
      createMediaChunkRepository(),
      repositoryB,
    );

    serviceB.start();
    serviceA.start();
    await flushPromises();

    expect(repositoryB.findPeersForChunk(mediaObjectId, chunks[0].id)).toEqual(['peer-a']);

    serviceA.stop();
    serviceB.stop();
  });

  it('announces old local chunk availability to peers that connect after service start', async () => {
    const mediaObjectId = 'media_late_peer_manifest_hash';
    const chunks = [
      MediaChunk.create(mediaObjectId, 0, new Uint8Array([7, 7]), 'peer-a').getData(),
    ];
    const mediaObject = createMediaObject(mediaObjectId, chunks, 'peer-a' as PeerId);
    const transportA = new InMemoryPeerTransport('peer-a' as PeerId);
    const transportB = new InMemoryPeerTransport('peer-b' as PeerId);
    const repositoryA = await createDownloadRepository();
    const repositoryB = await createDownloadRepository();
    const serviceA = createSignedMediaSyncService(
      'peer-a' as PeerId,
      transportA,
      createMediaObjectRepository([mediaObject]),
      createMediaChunkRepository(chunks),
      repositoryA,
    );
    const serviceB = createSignedMediaSyncService(
      'peer-b' as PeerId,
      transportB,
      createMediaObjectRepository(),
      createMediaChunkRepository(),
      repositoryB,
    );
    serviceA.start();
    serviceB.start();
    await transportA.connect(transportB);

    await serviceA.announceLocalAvailability();
    await flushPromises();

    expect(repositoryB.findPeersForChunk(mediaObjectId, chunks[0].id)).toEqual(['peer-a']);

    serviceA.stop();
    serviceB.stop();
  });

  it('resumes failed downloads when a new availability manifest arrives', async () => {
    const mediaObjectId = 'media_manifest_resume_hash';
    const chunks = [
      MediaChunk.create(mediaObjectId, 0, new Uint8Array([3, 2, 1]), 'peer-a').getData(),
    ];
    const mediaObject = createMediaObject(mediaObjectId, chunks, 'peer-a' as PeerId);
    const transportA = new InMemoryPeerTransport('peer-a' as PeerId);
    const transportB = new InMemoryPeerTransport('peer-b' as PeerId);
    await transportA.connect(transportB);
    const repositoryA = await createDownloadRepository();
    const repositoryB = await createDownloadRepository();
    await repositoryB.saveState({
      mediaObjectId,
      status: 'failed',
      totalChunks: 1,
      downloadedChunks: 0,
      requestedChunks: 1,
      failedChunks: 1,
      candidatePeers: [],
      updatedAt: 1,
      error: 'No connected peers can serve this media',
    });
    const serviceA = createSignedMediaSyncService(
      'peer-a' as PeerId,
      transportA,
      createMediaObjectRepository([mediaObject]),
      createMediaChunkRepository(chunks),
      repositoryA,
    );
    const mediaChunksB = createMediaChunkRepository();
    const serviceB = createSignedMediaSyncService(
      'peer-b' as PeerId,
      transportB,
      createMediaObjectRepository([mediaObject]),
      mediaChunksB,
      repositoryB,
      { requestTimeoutMs: 1, maxAttemptsPerChunk: 1 },
    );
    serviceB.start();
    serviceA.start();

    await serviceA.announceLocalAvailability();
    await flushPromises();

    expect(serviceB.getDownloadState(mediaObjectId)).toMatchObject({ status: 'available' });
    await expect(mediaChunksB.getByMediaObjectId(mediaObjectId)).resolves.toHaveLength(1);

    serviceA.stop();
    serviceB.stop();
  });

  it('uses a persisted signed announcement when the original source peer is offline', async () => {
    const mediaObjectId = 'media_manifest_download_hash';
    const chunks = [
      MediaChunk.create(mediaObjectId, 0, new Uint8Array([5, 4, 3]), 'peer-c').getData(),
    ];
    const post = createPostWithAttachment(mediaObjectId, chunks);
    const transportB = new InMemoryPeerTransport('peer-b' as PeerId);
    const transportC = new InMemoryPeerTransport('peer-c' as PeerId);
    await transportB.connect(transportC);

    const repositoryB = await createDownloadRepository();
    await repositoryB.saveAnnouncement({
      version: 2,
      peerId: 'peer-c' as PeerId,
      sequence: 1,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      pageIndex: 0,
      pageCount: 1,
      items: [
        {
          mediaObjectId,
          chunks: chunks.map((chunk) => chunk.id),
          totalChunks: chunks.length,
          updatedAt: 1,
        },
      ],
      signature: 'persisted-signature',
    });
    const serviceC = new PeerMediaSyncService(
      'peer-c' as PeerId,
      transportC,
      createMediaObjectRepository(),
      createMediaChunkRepository(chunks),
    );
    const mediaChunksB = createMediaChunkRepository();
    const serviceB = new PeerMediaSyncService(
      'peer-b' as PeerId,
      transportB,
      createMediaObjectRepository(),
      mediaChunksB,
      undefined,
      { requestTimeoutMs: 1, maxAttemptsPerChunk: 1 },
      repositoryB,
    );
    serviceC.start();
    serviceB.start();

    const result = await serviceB.ensurePostMediaAvailable(post, 'peer-a' as PeerId);

    expect(result).toEqual({ requested: 1, received: 1, skipped: 0, failed: 0 });
    expect(serviceB.getDownloadState(mediaObjectId)).toMatchObject({
      status: 'available',
      candidatePeers: ['peer-c'],
    });
    await expect(mediaChunksB.getByMediaObjectId(mediaObjectId)).resolves.toHaveLength(1);

    serviceB.stop();
    serviceC.stop();
  });

  it('restores persisted in-flight downloads and resumes them on start', async () => {
    const mediaObjectId = 'media_resume_hash';
    const chunks = [
      MediaChunk.create(mediaObjectId, 0, new Uint8Array([1, 3, 5]), 'peer-a').getData(),
    ];
    const mediaObject = createMediaObject(mediaObjectId, chunks, 'peer-a' as PeerId);
    const transportA = new InMemoryPeerTransport('peer-a' as PeerId);
    const transportB = new InMemoryPeerTransport('peer-b' as PeerId);
    await transportA.connect(transportB);

    const repositoryB = await createDownloadRepository();
    await repositoryB.saveState({
      mediaObjectId,
      status: 'downloading',
      totalChunks: 1,
      downloadedChunks: 0,
      requestedChunks: 1,
      failedChunks: 1,
      candidatePeers: ['peer-a' as PeerId],
      updatedAt: 1,
      error: 'Interrupted download',
    });
    const mediaChunksB = createMediaChunkRepository();
    const serviceA = new PeerMediaSyncService(
      'peer-a' as PeerId,
      transportA,
      createMediaObjectRepository([mediaObject]),
      createMediaChunkRepository(chunks),
    );
    const serviceB = new PeerMediaSyncService(
      'peer-b' as PeerId,
      transportB,
      createMediaObjectRepository([mediaObject]),
      mediaChunksB,
      undefined,
      { requestTimeoutMs: 1, maxAttemptsPerChunk: 1 },
      repositoryB,
    );
    serviceA.start();
    serviceB.start();
    await flushPromises();

    expect(serviceB.getDownloadState(mediaObjectId)).toMatchObject({ status: 'available' });
    await expect(mediaChunksB.getByMediaObjectId(mediaObjectId)).resolves.toHaveLength(1);

    serviceA.stop();
    serviceB.stop();
  });

  it('emits queued and available states for queued media downloads', async () => {
    const mediaObjectId = 'media_queue_hash';
    const chunks = [
      MediaChunk.create(mediaObjectId, 0, new Uint8Array([2, 4, 6]), 'peer-a').getData(),
    ];
    const mediaObject = createMediaObject(mediaObjectId, chunks, 'peer-a' as PeerId);
    const transportA = new InMemoryPeerTransport('peer-a' as PeerId);
    const transportB = new InMemoryPeerTransport('peer-b' as PeerId);
    await transportA.connect(transportB);

    const observed: string[] = [];
    const serviceA = new PeerMediaSyncService(
      'peer-a' as PeerId,
      transportA,
      createMediaObjectRepository([mediaObject]),
      createMediaChunkRepository(chunks),
    );
    const serviceB = new PeerMediaSyncService(
      'peer-b' as PeerId,
      transportB,
      createMediaObjectRepository([mediaObject]),
      createMediaChunkRepository(),
      undefined,
      { requestTimeoutMs: 1, maxAttemptsPerChunk: 1 },
    );
    serviceA.start();
    serviceB.start();
    const unsubscribe = serviceB.subscribeDownloadStates((state) => {
      if (state.mediaObjectId === mediaObjectId) {
        observed.push(state.status);
      }
    });

    await serviceB.enqueueMediaObjectData(mediaObject, { priority: 10 });
    await flushPromises();

    expect(observed).toContain('queued');
    expect(observed).toContain('available');
    expect(serviceB.getDownloadState(mediaObjectId)).toMatchObject({ status: 'available' });

    unsubscribe();
    serviceA.stop();
    serviceB.stop();
  });

  it('removes only a corrupt persisted chunk and resumes from that position', async () => {
    const mediaObjectId = 'media_bootstrap_resume';
    const chunks = [
      MediaChunk.create(mediaObjectId, 0, new Uint8Array([41, 42]), 'peer-a').getData(),
      MediaChunk.create(mediaObjectId, 1, new Uint8Array([43, 44]), 'peer-a').getData(),
    ];
    const mediaObject = createMediaObject(mediaObjectId, chunks, 'peer-a' as PeerId);
    const corruptFirstChunk = {
      ...chunks[0],
      chunkData: new Uint8Array([99, 42]),
    };
    const transportA = new InMemoryPeerTransport('peer-a' as PeerId);
    const transportB = new InMemoryPeerTransport('peer-b' as PeerId);
    await transportA.connect(transportB);
    const mediaChunksB = createMediaChunkRepository([corruptFirstChunk, chunks[1]]);

    const serviceA = new PeerMediaSyncService(
      'peer-a' as PeerId,
      transportA,
      createMediaObjectRepository([mediaObject]),
      createMediaChunkRepository(chunks),
    );
    const serviceB = new PeerMediaSyncService(
      'peer-b' as PeerId,
      transportB,
      createMediaObjectRepository([mediaObject]),
      mediaChunksB,
    );
    serviceA.start();
    serviceB.start();

    const result = await serviceB.ensureMediaObjectAvailable(mediaObject, 'peer-a' as PeerId);

    expect(result).toEqual({ requested: 1, received: 1, skipped: 1, failed: 0 });
    await expect(mediaChunksB.getByMediaObjectId(mediaObjectId)).resolves.toEqual(chunks);
    expect(serviceB.getDownloadState(mediaObjectId)).toMatchObject({
      status: 'available',
      downloadedChunks: 2,
    });

    serviceA.stop();
    serviceB.stop();
  });

  it('cancels queued media downloads before they start', async () => {
    const mediaObjectId = 'media_cancel_hash';
    const chunks = [MediaChunk.create(mediaObjectId, 0, new Uint8Array([8]), 'peer-a').getData()];
    const mediaObject = createMediaObject(mediaObjectId, chunks, 'peer-a' as PeerId);
    const service = new PeerMediaSyncService(
      'peer-b' as PeerId,
      new InMemoryPeerTransport('peer-b' as PeerId),
      createMediaObjectRepository([mediaObject]),
      createMediaChunkRepository(),
      undefined,
      { maxConcurrentDownloads: 0 },
    );
    service.start();

    await expect(service.enqueueMediaObjectData(mediaObject)).resolves.toMatchObject({
      status: 'queued',
    });
    await expect(service.cancelMediaDownload(mediaObjectId)).resolves.toMatchObject({
      status: 'cancelled',
    });

    service.stop();
  });

  it('accepts a replica offer only when local quota can hold the missing bytes', async () => {
    const mediaObjectId = 'media_replica_offer';
    const chunks = [
      MediaChunk.create(mediaObjectId, 0, new Uint8Array([8, 9, 10]), 'peer-a').getData(),
    ];
    const mediaObject = createMediaObject(mediaObjectId, chunks, 'peer-a' as PeerId);
    const transportA = new InMemoryPeerTransport('peer-a' as PeerId);
    const transportB = new InMemoryPeerTransport('peer-b' as PeerId);
    await transportA.connect(transportB);
    const chunksB = createMediaChunkRepository();
    const serviceA = new PeerMediaSyncService(
      'peer-a' as PeerId,
      transportA,
      createMediaObjectRepository([mediaObject]),
      createMediaChunkRepository(chunks),
    );
    const serviceB = new PeerMediaSyncService(
      'peer-b' as PeerId,
      transportB,
      createMediaObjectRepository([mediaObject]),
      chunksB,
      undefined,
      { maxLocalMediaBytes: 10 },
    );
    serviceA.start();
    serviceB.start();

    await expect(serviceA.offerReplica('peer-b' as PeerId, mediaObjectId)).resolves.toBe(true);
    await flushPromises();

    expect(serviceB.getDownloadState(mediaObjectId)).toMatchObject({ status: 'available' });
    await expect(chunksB.getByMediaObjectId(mediaObjectId)).resolves.toHaveLength(1);
    serviceA.stop();
    serviceB.stop();
  });

  it('rejects a replica offer without creating a download when quota is full', async () => {
    const mediaObjectId = 'media_replica_offer_quota';
    const chunks = [
      MediaChunk.create(mediaObjectId, 0, new Uint8Array([8, 9, 10]), 'peer-a').getData(),
    ];
    const mediaObject = createMediaObject(mediaObjectId, chunks, 'peer-a' as PeerId);
    const transportA = new InMemoryPeerTransport('peer-a' as PeerId);
    const transportB = new InMemoryPeerTransport('peer-b' as PeerId);
    await transportA.connect(transportB);
    const chunksB = createMediaChunkRepository();
    const serviceA = new PeerMediaSyncService(
      'peer-a' as PeerId,
      transportA,
      createMediaObjectRepository([mediaObject]),
      createMediaChunkRepository(chunks),
    );
    const serviceB = new PeerMediaSyncService(
      'peer-b' as PeerId,
      transportB,
      createMediaObjectRepository([mediaObject]),
      chunksB,
      undefined,
      { maxLocalMediaBytes: 1 },
    );
    serviceA.start();
    serviceB.start();

    await expect(serviceA.offerReplica('peer-b' as PeerId, mediaObjectId)).resolves.toBe(true);
    await flushPromises();

    expect(serviceB.getDownloadState(mediaObjectId)).toBeNull();
    await expect(chunksB.getByMediaObjectId(mediaObjectId)).resolves.toEqual([]);
    serviceA.stop();
    serviceB.stop();
  });
});

function createPostWithAttachment(mediaObjectId: string, chunks: MediaChunkData[]): PostData {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.size, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk.chunkData, offset);
    offset += chunk.chunkData.length;
  }
  return {
    id: 'post_with_image',
    author: 'peer-a' as PeerId,
    createdAt: 1,
    updatedAt: 1,
    signature: 'post-signature',
    version: '2.0.0',
    text: 'image post',
    contentHash: 'post-hash',
    mediaAttachments: [
      {
        id: mediaObjectId,
        type: 'image',
        mime: 'image/png',
        size: bytes.length,
        hash: sha256Hex(bytes),
        chunks: chunks.map((chunk) => chunk.id),
        name: 'photo.png',
      },
    ],
    deleted: false,
  };
}

function createMediaObject(
  mediaObjectId: string,
  chunks: MediaChunkData[],
  author: PeerId,
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
    createdAt: 1,
    updatedAt: 1,
    signature: 'media-signature',
    version: '1.0',
    type: 'image',
    mime: 'image/png',
    size: bytes.length,
    hash: sha256Hex(bytes),
    chunks: chunks.map((chunk) => chunk.id),
  };
}

async function createDownloadRepository(): Promise<MediaDownloadRepository> {
  const database = await openDatabaseService({ forceMemory: true });
  const repository = new MediaDownloadRepository(database, createMemoryStorage());
  await repository.initialize();
  return repository;
}

function createSignedMediaSyncService(
  peerId: PeerId,
  transport: InMemoryPeerTransport,
  mediaObjectRepository: MediaObjectRepository,
  mediaChunkRepository: MediaChunkRepository,
  downloadRepository: MediaDownloadRepository,
  options: PeerMediaSyncOptions = {},
): PeerMediaSyncService {
  return new PeerMediaSyncService(
    peerId,
    transport,
    mediaObjectRepository,
    mediaChunkRepository,
    undefined,
    options,
    downloadRepository,
    new MediaIntegrityService(),
    new MediaAvailabilityService(
      peerId,
      new TestMediaAvailabilityCrypto(peerId),
      downloadRepository,
    ),
    new MediaSourceSelector(downloadRepository),
  );
}

class TestMediaAvailabilityCrypto implements MediaAvailabilityCrypto {
  constructor(private readonly identity: string) {}

  async sign(data: string): Promise<string> {
    return sha256Hex(`${this.identity}:${data}`);
  }

  async verify(data: string, signature: string, publicIdentity: string): Promise<boolean> {
    return signature === sha256Hex(`${publicIdentity}:${data}`);
  }
}

function createMemoryStorage() {
  const values = new Map<string, string>();
  return createStorageService({
    getString: (key) => values.get(key) ?? null,
    setString: (key, value) => {
      values.set(key, value);
    },
    remove: (key) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
  });
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
}

function testBytesToBase64(bytes: Uint8Array): string {
  return globalThis.btoa(String.fromCharCode(...bytes));
}
