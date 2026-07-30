import { CryptoService } from '@/crypto/CryptoService';
import { openDatabaseService } from '@/database/sqliteAdapter.web';
import type { PostData } from '@/models/Post';
import { InMemoryPeerTransport } from '@/network/PeerTransport';
import type { NetworkService } from '@/services/network/NetworkService';
import { PeerHandshakeProtocol } from '@/services/peers/PeerHandshakeProtocol';
import { PeerSessionService } from '@/services/peers/PeerSessionService';
import { PeerTrustService } from '@/services/peers/PeerTrustService';
import { TrustedPeerRepository } from '@/services/peers/TrustedPeerRepository';
import { createStorageService, type StorageDriver } from '@/services/storage/StorageService';

import { IncrementalSyncService } from '../IncrementalSyncService';
import { PeerIncrementalSyncProtocol } from '../PeerIncrementalSyncProtocol';
import { SyncCheckpointRepository } from '../SyncCheckpointRepository';

let mockKeyCounter = 80;

jest.mock('expo-crypto', () => ({
  getRandomBytesAsync: jest.fn(() => {
    mockKeyCounter += 1;
    return Promise.resolve(new Uint8Array(32).map((_, index) => (index + mockKeyCounter) % 256));
  }),
}));

function createMemoryDriver(): StorageDriver {
  const data = new Map<string, string>();
  return {
    getString: (key) => data.get(key) ?? null,
    setString: (key, value) => data.set(key, value),
    remove: (key) => data.delete(key),
    clear: () => data.clear(),
  };
}

function createNetworkService(peerId: string, publicIdentity: string): NetworkService {
  return {
    getLocalIdentity: async () => ({ peerId, publicIdentity, createdAt: 1 }),
    getPeerManager: () => ({ getPeerId: () => peerId }),
  } as unknown as NetworkService;
}

function createPost(id: string, updatedAt: number, text = `post ${id}`): PostData {
  return {
    id,
    author: 'peer-b',
    createdAt: updatedAt,
    updatedAt,
    signature: `sig-${id}`,
    version: '1',
    text,
    contentHash: `hash-${id}`,
    mediaAttachments: [],
    deleted: false,
  };
}

function createPostRepository(initial: PostData[] = []) {
  const posts = new Map(initial.map((post) => [post.id, post]));
  return {
    getAll: async () => Array.from(posts.values()).sort((a, b) => b.createdAt - a.createdAt),
    getById: async (id: string) => posts.get(id) ?? null,
    getByContentHash: async (hash: string) =>
      Array.from(posts.values()).filter((post) => post.contentHash === hash),
    create: async (post: PostData) => {
      posts.set(post.id, post);
    },
    update: async (post: PostData) => {
      posts.set(post.id, post);
    },
    dump: () => Array.from(posts.values()),
  };
}

function createCheckpointedSync(
  peerId: string,
  repository: ReturnType<typeof createPostRepository>,
  trustedPeers: TrustedPeerRepository,
  checkpoints: SyncCheckpointRepository,
  batchSize = 10,
): IncrementalSyncService {
  return new IncrementalSyncService(
    peerId,
    repository as never,
    trustedPeers,
    batchSize,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    checkpoints,
  );
}

function markVerified(repository: TrustedPeerRepository, peerId: string): void {
  repository.upsert({ peerId, addresses: [], source: 'invite' });
  repository.markVerified(peerId, {
    peerId,
    identityId: peerId,
    publicKey: `public-${peerId}`,
    displayName: peerId,
    timestamp: 1,
    signature: `sig-${peerId}`,
  });
}

describe('PeerIncrementalSyncProtocol', () => {
  it('syncs posts incrementally after a verified peer handshake', async () => {
    const transportA = new InMemoryPeerTransport('peer-a');
    const transportB = new InMemoryPeerTransport('peer-b');
    await transportA.connect(transportB);

    const storageA = createStorageService(createMemoryDriver());
    const storageB = createStorageService(createMemoryDriver());
    const cryptoA = new CryptoService(storageA);
    const cryptoB = new CryptoService(storageB);
    const identityA = await cryptoA.createIdentity();
    const identityB = await cryptoB.createIdentity();
    const trustedA = new TrustedPeerRepository(storageA);
    const trustedB = new TrustedPeerRepository(storageB);
    trustedA.upsert({ peerId: 'peer-b', addresses: [], source: 'invite' });
    trustedB.upsert({ peerId: 'peer-a', addresses: [], source: 'invite' });

    const trustA = new PeerTrustService(trustedA, cryptoA, () =>
      createNetworkService('peer-a', identityA),
    );
    const trustB = new PeerTrustService(trustedB, cryptoB, () =>
      createNetworkService('peer-b', identityB),
    );
    const handshakeA = new PeerHandshakeProtocol(
      transportA,
      trustA,
      new PeerSessionService(trustedA),
    );
    const handshakeB = new PeerHandshakeProtocol(
      transportB,
      trustB,
      new PeerSessionService(trustedB),
    );
    handshakeA.start();
    handshakeB.start();
    await handshakeA.handshake('peer-b');

    const repoA = createPostRepository();
    const repoB = createPostRepository([createPost('remote-1', 100), createPost('remote-2', 200)]);
    const syncA = new IncrementalSyncService('peer-a', repoA as never, trustedA, 10);
    const syncB = new IncrementalSyncService('peer-b', repoB as never, trustedB, 10);
    const protocolA = new PeerIncrementalSyncProtocol(transportA, syncA, trustedA);
    const protocolB = new PeerIncrementalSyncProtocol(transportB, syncB, trustedB);
    protocolA.start();
    protocolB.start();

    const result = await protocolA.syncPeer('peer-b');

    expect(result).toMatchObject({ applied: 2, skipped: 0, hasMore: false });
    expect(
      repoA
        .dump()
        .map((post) => post.id)
        .sort(),
    ).toEqual(['remote-1', 'remote-2']);
    expect(trustedA.get('peer-b')?.syncCursor).toBe('200:remote-2');

    protocolA.stop();
    protocolB.stop();
    handshakeA.stop();
    handshakeB.stop();
  });

  it('splits oversized sync batches into multiple WebRTC-safe pages', async () => {
    const transportA = new InMemoryPeerTransport('peer-a');
    const transportB = new InMemoryPeerTransport('peer-b');
    await transportA.connect(transportB);

    const storageA = createStorageService(createMemoryDriver());
    const storageB = createStorageService(createMemoryDriver());
    const trustedA = new TrustedPeerRepository(storageA);
    const trustedB = new TrustedPeerRepository(storageB);
    trustedA.upsert({ peerId: 'peer-b', addresses: [], source: 'invite' });
    trustedB.upsert({ peerId: 'peer-a', addresses: [], source: 'invite' });
    trustedA.markVerified('peer-b', {
      peerId: 'peer-b',
      identityId: 'peer-b',
      publicKey: 'public-b',
      displayName: 'Peer B',
      timestamp: 1,
      signature: 'sig-b',
    });
    trustedB.markVerified('peer-a', {
      peerId: 'peer-a',
      identityId: 'peer-a',
      publicKey: 'public-a',
      displayName: 'Peer A',
      timestamp: 1,
      signature: 'sig-a',
    });

    const largeText = 'x'.repeat(80 * 1024);
    const repoA = createPostRepository();
    const repoB = createPostRepository([
      createPost('remote-1', 100, largeText),
      createPost('remote-2', 200, largeText),
      createPost('remote-3', 300, largeText),
      createPost('remote-4', 400, largeText),
    ]);
    const syncA = new IncrementalSyncService('peer-a', repoA as never, trustedA, 50);
    const syncB = new IncrementalSyncService('peer-b', repoB as never, trustedB, 50);
    const protocolA = new PeerIncrementalSyncProtocol(transportA, syncA, trustedA);
    const protocolB = new PeerIncrementalSyncProtocol(transportB, syncB, trustedB);
    protocolA.start();
    protocolB.start();

    const result = await protocolA.syncPeer('peer-b');

    expect(result).toMatchObject({ applied: 4, skipped: 0, hasMore: false });
    expect(
      repoA
        .dump()
        .map((post) => post.id)
        .sort(),
    ).toEqual(['remote-1', 'remote-2', 'remote-3', 'remote-4']);
    expect(trustedA.get('peer-b')?.syncCursor).toBe('400:remote-4');

    protocolA.stop();
    protocolB.stop();
  });

  it('skips a single sync record that is too large for one WebRTC envelope without closing sync', async () => {
    const transportA = new InMemoryPeerTransport('peer-a');
    const transportB = new InMemoryPeerTransport('peer-b');
    await transportA.connect(transportB);

    const storageA = createStorageService(createMemoryDriver());
    const storageB = createStorageService(createMemoryDriver());
    const trustedA = new TrustedPeerRepository(storageA);
    const trustedB = new TrustedPeerRepository(storageB);
    trustedA.upsert({ peerId: 'peer-b', addresses: [], source: 'invite' });
    trustedB.upsert({ peerId: 'peer-a', addresses: [], source: 'invite' });
    trustedA.markVerified('peer-b', {
      peerId: 'peer-b',
      identityId: 'peer-b',
      publicKey: 'public-b',
      displayName: 'Peer B',
      timestamp: 1,
      signature: 'sig-b',
    });
    trustedB.markVerified('peer-a', {
      peerId: 'peer-a',
      identityId: 'peer-a',
      publicKey: 'public-a',
      displayName: 'Peer A',
      timestamp: 1,
      signature: 'sig-a',
    });

    const repoA = createPostRepository();
    const repoB = createPostRepository([
      createPost('huge-remote', 100, 'x'.repeat(300 * 1024)),
      createPost('small-remote', 200, 'small enough'),
    ]);
    const syncA = new IncrementalSyncService('peer-a', repoA as never, trustedA, 50);
    const syncB = new IncrementalSyncService('peer-b', repoB as never, trustedB, 50);
    const protocolA = new PeerIncrementalSyncProtocol(transportA, syncA, trustedA);
    const protocolB = new PeerIncrementalSyncProtocol(transportB, syncB, trustedB);
    protocolA.start();
    protocolB.start();

    const result = await protocolA.syncPeer('peer-b');

    expect(result).toMatchObject({ applied: 1, skipped: 0, hasMore: false });
    expect(repoA.dump().map((post) => post.id)).toEqual(['small-remote']);
    expect(trustedA.get('peer-b')?.syncCursor).toBe('200:small-remote');

    protocolA.stop();
    protocolB.stop();
  });

  it('times out an unanswered incremental sync request', async () => {
    jest.useFakeTimers();
    try {
      const transportA = new InMemoryPeerTransport('peer-a');
      const transportB = new InMemoryPeerTransport('peer-b');
      await transportA.connect(transportB);

      const storageA = createStorageService(createMemoryDriver());
      const trustedA = new TrustedPeerRepository(storageA);
      trustedA.upsert({ peerId: 'peer-b', addresses: [], source: 'invite' });
      trustedA.markVerified('peer-b', {
        peerId: 'peer-b',
        identityId: 'peer-b',
        publicKey: 'public-b',
        displayName: 'Peer B',
        timestamp: 1,
        signature: 'sig-b',
      });

      const syncA = new IncrementalSyncService(
        'peer-a',
        createPostRepository() as never,
        trustedA,
        50,
      );
      const protocolA = new PeerIncrementalSyncProtocol(transportA, syncA, trustedA);
      protocolA.start();

      const syncPromise = protocolA.syncPeer('peer-b');
      jest.advanceTimersByTime(15000);

      await expect(syncPromise).rejects.toThrow('Incremental sync request timed out');
      protocolA.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('converges missing objects and tombstones, then skips data batches for unchanged manifests', async () => {
    const transportA = new InMemoryPeerTransport('peer-a');
    const transportB = new InMemoryPeerTransport('peer-b');
    await transportA.connect(transportB);
    const trustedA = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    const trustedB = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    markVerified(trustedA, 'peer-b');
    markVerified(trustedB, 'peer-a');

    const active = createPost('post-active', 100);
    const tombstone = {
      ...active,
      updatedAt: 300,
      signature: 'sig-post-active-deleted',
      deleted: true,
    };
    const repoA = createPostRepository([active]);
    const repoB = createPostRepository([createPost('missing-old', 50), tombstone]);
    const databaseA = await openDatabaseService({ forceMemory: true });
    const checkpointsA = new SyncCheckpointRepository(databaseA);
    const syncA = createCheckpointedSync('peer-a', repoA, trustedA, checkpointsA);
    const syncB = new IncrementalSyncService('peer-b', repoB as never, trustedB, 10);
    const protocolA = new PeerIncrementalSyncProtocol(transportA, syncA, trustedA);
    const protocolB = new PeerIncrementalSyncProtocol(transportB, syncB, trustedB);
    protocolA.start();
    protocolB.start();

    const first = await protocolA.syncPeer('peer-b');
    const batchSpy = jest.spyOn(syncB, 'createEntityBatch');
    const second = await protocolA.syncPeer('peer-b');

    expect(first.applied).toBe(2);
    expect(repoA.dump()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'missing-old', deleted: false }),
        expect.objectContaining({ id: 'post-active', deleted: true }),
      ]),
    );
    expect(await checkpointsA.list('peer-b')).toHaveLength(6);
    expect((await checkpointsA.list('peer-b')).every((item) => item.status === 'complete')).toBe(
      true,
    );
    expect(second).toMatchObject({ applied: 0, skipped: 0, hasMore: false });
    expect(batchSpy).not.toHaveBeenCalled();

    protocolA.stop();
    protocolB.stop();
    await databaseA.close();
  });

  it('asks a neighbor to pull state learned from another side of the mesh', async () => {
    const transportB = new InMemoryPeerTransport('peer-b');
    const transportC = new InMemoryPeerTransport('peer-c');
    await transportB.connect(transportC);
    const trustedB = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    const trustedC = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    markVerified(trustedB, 'peer-c');
    markVerified(trustedC, 'peer-b');

    const repoB = createPostRepository([createPost('relayed-post', 100)]);
    const repoC = createPostRepository();
    const syncB = new IncrementalSyncService('peer-b', repoB as never, trustedB, 10);
    const syncC = new IncrementalSyncService('peer-c', repoC as never, trustedC, 10);
    let protocolC: PeerIncrementalSyncProtocol;
    let resolveRefresh: (() => void) | undefined;
    const refreshed = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    const protocolB = new PeerIncrementalSyncProtocol(transportB, syncB, trustedB);
    protocolC = new PeerIncrementalSyncProtocol(transportC, syncC, trustedC, {
      onRefreshRequested: async (peerId) => {
        await protocolC.syncPeer(peerId);
        resolveRefresh?.();
      },
    });
    protocolB.start();
    protocolC.start();

    await protocolB.notifyPeerOfChanges('peer-c', 200);
    await refreshed;

    expect(repoC.dump()).toEqual([
      expect.objectContaining({ id: 'relayed-post', text: 'post relayed-post' }),
    ]);

    protocolB.stop();
    protocolC.stop();
  });

  it('resumes an interrupted entity scan from the last persisted cursor', async () => {
    const transportA = new InMemoryPeerTransport('peer-a');
    const transportB = new InMemoryPeerTransport('peer-b');
    await transportA.connect(transportB);
    const trustedA = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    const trustedB = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    markVerified(trustedA, 'peer-b');
    markVerified(trustedB, 'peer-a');

    const postA = createPost('post-a', 100);
    const postB = createPost('post-b', 200);
    const postC = createPost('post-c', 300);
    const repoA = createPostRepository([postA]);
    const repoB = createPostRepository([postA, postB, postC]);
    const databaseA = await openDatabaseService({ forceMemory: true });
    const checkpointsA = new SyncCheckpointRepository(databaseA);
    const syncA = createCheckpointedSync('peer-a', repoA, trustedA, checkpointsA, 1);
    const syncB = new IncrementalSyncService('peer-b', repoB as never, trustedB, 1);
    const remoteManifest = await syncB.createEntityManifest('post');
    await checkpointsA.saveProgress({
      peerId: 'peer-b',
      entity: 'post',
      cursor: '100:post-a',
      manifestHash: remoteManifest.rootHash,
      syncedObjects: 1,
    });
    const protocolA = new PeerIncrementalSyncProtocol(transportA, syncA, trustedA);
    const protocolB = new PeerIncrementalSyncProtocol(transportB, syncB, trustedB);
    protocolA.start();
    protocolB.start();

    const result = await protocolA.syncPeer('peer-b');

    expect(result.applied).toBe(2);
    expect(
      repoA
        .dump()
        .map((post) => post.id)
        .sort(),
    ).toEqual(['post-a', 'post-b', 'post-c']);
    await expect(checkpointsA.get('peer-b', 'post')).resolves.toMatchObject({
      status: 'complete',
      cursor: undefined,
      syncedObjects: 3,
    });

    protocolA.stop();
    protocolB.stop();
    await databaseA.close();
  });

  it('does not advance a checkpoint when a v2 page cannot be persisted', async () => {
    const transportA = new InMemoryPeerTransport('peer-a');
    const transportB = new InMemoryPeerTransport('peer-b');
    await transportA.connect(transportB);
    const trustedA = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    const trustedB = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    markVerified(trustedA, 'peer-b');
    markVerified(trustedB, 'peer-a');

    const repoA = createPostRepository();
    repoA.create = async () => {
      throw new Error('local write failed');
    };
    const repoB = createPostRepository([createPost('post-b', 100)]);
    const databaseA = await openDatabaseService({ forceMemory: true });
    const checkpointsA = new SyncCheckpointRepository(databaseA);
    const syncA = createCheckpointedSync('peer-a', repoA, trustedA, checkpointsA);
    const syncB = new IncrementalSyncService('peer-b', repoB as never, trustedB, 10);
    const protocolA = new PeerIncrementalSyncProtocol(transportA, syncA, trustedA);
    const protocolB = new PeerIncrementalSyncProtocol(transportB, syncB, trustedB);
    protocolA.start();
    protocolB.start();

    await expect(protocolA.syncPeer('peer-b')).rejects.toThrow('local write failed');
    await expect(checkpointsA.get('peer-b', 'post')).resolves.toBeNull();

    protocolA.stop();
    protocolB.stop();
    await databaseA.close();
  });
});
