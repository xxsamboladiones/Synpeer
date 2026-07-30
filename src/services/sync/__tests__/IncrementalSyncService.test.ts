import type { ChatMessageData } from '@/models/ChatMessage';
import { openDatabaseService } from '@/database/sqliteAdapter.web';
import { AppError } from '@/errors/AppError';
import type { PostData } from '@/models/Post';
import type { ProfileData } from '@/models/Profile';
import type { PeerId } from '@/network/NetworkTypes';
import { PostRepository } from '@/repositories/PostRepository';
import { createStorageService, type StorageDriver } from '@/services/storage/StorageService';
import { SocialEventBus } from '@/services/social/SocialEventBus';
import { TrustedPeerRepository } from '@/services/peers/TrustedPeerRepository';

import { decodeCursor, encodeCursor, IncrementalSyncService } from '../IncrementalSyncService';

function createMemoryDriver(): StorageDriver {
  const data = new Map<string, string>();
  return {
    getString: (key) => data.get(key) ?? null,
    setString: (key, value) => data.set(key, value),
    remove: (key) => data.delete(key),
    clear: () => data.clear(),
  };
}

function createPost(id: string, updatedAt: number, contentHash = `hash-${id}`): PostData {
  return {
    id,
    author: 'alice',
    createdAt: updatedAt,
    updatedAt,
    signature: `sig-${id}`,
    version: '1',
    text: `post ${id}`,
    contentHash,
    mediaAttachments: [],
    deleted: false,
  };
}

function createProfile(author: string, updatedAt: number): ProfileData {
  return {
    id: `profile_${author}`,
    author,
    createdAt: updatedAt,
    updatedAt,
    signature: `sig-profile-${author}-${updatedAt}`,
    version: '1',
    username: author,
    displayName: author,
    postCount: 0,
    followerCount: 0,
    followingCount: 0,
  };
}

function createChatMessage(
  id: string,
  updatedAt: number,
  senderId = 'alice',
  recipientId = 'bob',
): ChatMessageData {
  return {
    id,
    author: senderId as PeerId,
    createdAt: updatedAt,
    updatedAt,
    signature: `sig-${id}`,
    version: '1',
    conversationId: [senderId, recipientId].sort().join(':'),
    senderId: senderId as PeerId,
    recipientId: recipientId as PeerId,
    text: `message ${id}`,
    contentHash: `hash-${id}`,
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

function createProfileRepository(initial: ProfileData[] = []) {
  const profiles = new Map(initial.map((profile) => [profile.author, profile]));
  return {
    getAll: async () => Array.from(profiles.values()).sort((a, b) => b.updatedAt - a.updatedAt),
    getByAuthor: async (author: string) => profiles.get(author) ?? null,
    create: async (profile: ProfileData) => {
      profiles.set(profile.author, profile);
    },
    update: async (profile: ProfileData) => {
      profiles.set(profile.author, profile);
    },
    dump: () => Array.from(profiles.values()),
  };
}

function createChatMessageRepository(initial: ChatMessageData[] = []) {
  const messages = new Map(initial.map((message) => [message.id, message]));
  return {
    getAll: async () => Array.from(messages.values()).sort((a, b) => b.updatedAt - a.updatedAt),
    getById: async (id: string) => messages.get(id) ?? null,
    getByContentHash: async (hash: string) =>
      Array.from(messages.values()).filter((message) => message.contentHash === hash),
    create: async (message: ChatMessageData) => {
      messages.set(message.id, message);
    },
    update: async (message: ChatMessageData) => {
      messages.set(message.id, message);
    },
    dump: () => Array.from(messages.values()),
  };
}

describe('IncrementalSyncService', () => {
  it('creates manifest and batch after a cursor without resending older posts', async () => {
    const repo = createPostRepository([
      createPost('a', 100),
      createPost('b', 200),
      createPost('c', 300),
    ]);
    const trustedPeers = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    const sync = new IncrementalSyncService('local-peer', repo as never, trustedPeers, 10);

    const manifest = await sync.createManifest(encodeCursor(createPost('a', 100)));
    const batch = await sync.createBatch(manifest.cursor);

    expect(manifest.items.map((item) => item.id)).toEqual(['b', 'c']);
    expect(batch.posts.map((post) => post.id)).toEqual(['b', 'c']);
    expect(decodeCursor(batch.nextCursor)).toEqual({ updatedAt: 300, id: 'c' });
  });

  it('applies only missing posts and records peer cursor projection', async () => {
    const localRepo = createPostRepository([createPost('existing', 100, 'same-hash')]);
    const trustedPeers = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    trustedPeers.upsert({ peerId: 'peer-b', source: 'invite' });
    const sync = new IncrementalSyncService('local-peer', localRepo as never, trustedPeers, 10);

    const result = await sync.applyBatch('peer-b', {
      version: 1,
      peerId: 'peer-b',
      nextCursor: '300:c',
      hasMore: false,
      posts: [createPost('duplicate', 200, 'same-hash'), createPost('new', 300, 'new-hash')],
    });

    expect(result).toEqual({
      applied: 1,
      skipped: 1,
      nextCursor: '300:c',
      hasMore: false,
    });
    expect(
      localRepo
        .dump()
        .map((post) => post.id)
        .sort(),
    ).toEqual(['existing', 'new']);
    expect(trustedPeers.get('peer-b')).toMatchObject({
      syncCursor: '300:c',
      syncedObjects: 1,
    });
  });

  it('emits a social sync event when remote objects are applied', async () => {
    const localRepo = createPostRepository();
    const trustedPeers = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    trustedPeers.upsert({ peerId: 'peer-b', source: 'invite' });
    const events = new SocialEventBus();
    const observed: string[] = [];
    events.subscribe((event) => {
      if (event.type === 'social.sync.completed') {
        observed.push(`${event.peerId}:${event.received}`);
      }
    });
    const sync = new IncrementalSyncService(
      'local-peer',
      localRepo as never,
      trustedPeers,
      10,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      events,
    );

    await sync.applyBatch('peer-b', {
      version: 1,
      peerId: 'peer-b',
      nextCursor: '300:new',
      hasMore: false,
      posts: [createPost('new', 300, 'new-hash')],
    });

    expect(observed).toEqual(['peer-b:1']);
  });

  it('includes profiles in incremental batches and applies missing remote profiles', async () => {
    const localPosts = createPostRepository([createPost('existing-post', 100)]);
    const localProfiles = createProfileRepository();
    const remoteProfile = createProfile('peer-b', 250);
    const remoteProfiles = createProfileRepository([remoteProfile]);
    const trustedPeers = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    trustedPeers.upsert({ peerId: 'peer-b', source: 'invite' });
    const remoteSync = new IncrementalSyncService(
      'peer-b',
      createPostRepository() as never,
      trustedPeers,
      10,
      remoteProfiles as never,
    );
    const localSync = new IncrementalSyncService(
      'local-peer',
      localPosts as never,
      trustedPeers,
      10,
      localProfiles as never,
    );

    const batch = await remoteSync.createBatch();
    const result = await localSync.applyBatch('peer-b', batch);

    expect(batch.profiles?.map((profile) => profile.author)).toEqual(['peer-b']);
    expect(result).toMatchObject({ applied: 1, skipped: 0, hasMore: false });
    expect(localProfiles.dump()).toEqual([remoteProfile]);
  });

  it('skips a corrupt profile without blocking valid posts in the same batch', async () => {
    const localPosts = createPostRepository();
    const trustedPeers = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    trustedPeers.upsert({ peerId: 'peer-b', source: 'invite' });
    const rejectingProfiles = {
      getByAuthor: async () => null,
      create: async () => {
        throw new Error('Remote profile signature is invalid');
      },
      update: async () => {
        throw new Error('Remote profile signature is invalid');
      },
    };
    const sync = new IncrementalSyncService(
      'local-peer',
      localPosts as never,
      trustedPeers,
      10,
      rejectingProfiles as never,
    );

    const result = await sync.applyBatch('peer-b', {
      version: 1,
      peerId: 'peer-b',
      nextCursor: '300:profile_peer-b',
      hasMore: false,
      posts: [createPost('new', 200, 'new-hash')],
      profiles: [createProfile('peer-b', 300)],
    });

    expect(result).toMatchObject({ applied: 1, skipped: 1, hasMore: false });
    expect(localPosts.dump().map((post) => post.id)).toEqual(['new']);
    expect(trustedPeers.get('peer-b')).toMatchObject({
      syncCursor: '300:profile_peer-b',
      syncedObjects: 1,
    });
  });

  it('does not retry a v2 page solely because a remote record failed non-retryable validation', async () => {
    const localPosts = createPostRepository();
    const trustedPeers = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    const rejectingProfiles = {
      getByAuthor: async () => null,
      create: async () => {
        throw new AppError({
          code: 'VALIDATION_ERROR',
          message: 'Remote profile signature is invalid',
          retryable: false,
        });
      },
      update: async () => undefined,
    };
    const sync = new IncrementalSyncService(
      'local-peer',
      localPosts as never,
      trustedPeers,
      10,
      rejectingProfiles as never,
    );

    await expect(
      sync.applyBatch('peer-b', {
        version: 2,
        peerId: 'peer-b',
        entity: 'profile',
        itemIds: ['profile_peer-b'],
        hasMore: false,
        posts: [],
        profiles: [createProfile('peer-b', 300)],
      }),
    ).resolves.toMatchObject({ applied: 0, skipped: 1, hasMore: false });
  });

  it('includes chat messages in incremental batches and applies missing remote messages', async () => {
    const localPosts = createPostRepository();
    const localChats = createChatMessageRepository();
    const remoteMessage = createChatMessage('chat-1', 400);
    const remoteChats = createChatMessageRepository([remoteMessage]);
    const trustedPeers = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    trustedPeers.upsert({ peerId: 'peer-b', source: 'invite' });
    const remoteSync = new IncrementalSyncService(
      'peer-b',
      createPostRepository() as never,
      trustedPeers,
      10,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      remoteChats as never,
    );
    const localSync = new IncrementalSyncService(
      'local-peer',
      localPosts as never,
      trustedPeers,
      10,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      localChats as never,
    );

    const batch = await remoteSync.createBatch();
    const result = await localSync.applyBatch('peer-b', batch);

    expect(batch.chatMessages?.map((message) => message.id)).toEqual(['chat-1']);
    expect(result).toMatchObject({ applied: 1, skipped: 0, hasMore: false });
    expect(localChats.dump()).toEqual([remoteMessage]);
  });

  it('only exposes chat history to the peer participating in that conversation', async () => {
    const chats = createChatMessageRepository([
      createChatMessage('chat-bob', 400, 'alice', 'bob'),
      createChatMessage('chat-carol', 500, 'alice', 'carol'),
      {
        ...createChatMessage('chat-relay', 600, 'dave', 'bob'),
        relayOnly: true,
      },
    ]);
    const trustedPeers = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    const sync = new IncrementalSyncService(
      'alice',
      createPostRepository() as never,
      trustedPeers,
      10,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      chats as never,
    );

    const bobBatch = await sync.createBatch(undefined, 10, 'bob' as PeerId);
    const carolBatch = await sync.createBatch(undefined, 10, 'carol' as PeerId);

    expect(bobBatch.chatMessages?.map((message) => message.id)).toEqual(['chat-bob']);
    expect(carolBatch.chatMessages?.map((message) => message.id)).toEqual(['chat-carol']);
  });

  it('includes signed tombstones in entity manifests and applies them over active records', async () => {
    const activePost = createPost('post-a', 100);
    const tombstone = {
      ...activePost,
      updatedAt: 300,
      signature: 'sig-post-a-deleted',
      deleted: true,
    };
    const localPosts = createPostRepository([activePost]);
    const remotePosts = createPostRepository([tombstone]);
    const trustedPeers = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    trustedPeers.upsert({ peerId: 'peer-b', source: 'invite' });
    const localSync = new IncrementalSyncService(
      'local-peer',
      localPosts as never,
      trustedPeers,
      10,
    );
    const remoteSync = new IncrementalSyncService('peer-b', remotePosts as never, trustedPeers, 10);

    const manifest = await remoteSync.createEntityManifest('post');
    const missing = await localSync.findMissingManifestItems(manifest);
    const batch = await remoteSync.createEntityBatch(
      'post',
      missing.map((item) => item.id),
    );
    const result = await localSync.applyBatch('peer-b', batch);

    expect(manifest.items).toEqual([expect.objectContaining({ id: 'post-a', deleted: true })]);
    expect(result).toMatchObject({ applied: 1, skipped: 0 });
    expect(localPosts.dump()).toEqual([tombstone]);
  });

  it('uses deterministic range hashes to find an old object missing before the latest cursor', async () => {
    const shared = createPost('shared', 200);
    const missingOldPost = createPost('missing-old', 100);
    const localPosts = createPostRepository([shared]);
    const remotePosts = createPostRepository([missingOldPost, shared]);
    const trustedPeers = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    const localSync = new IncrementalSyncService(
      'local-peer',
      localPosts as never,
      trustedPeers,
      10,
    );
    const remoteSync = new IncrementalSyncService('peer-b', remotePosts as never, trustedPeers, 10);

    const firstManifest = await remoteSync.createEntityManifest('post');
    const repeatedManifest = await remoteSync.createEntityManifest('post');
    const missing = await localSync.findMissingManifestItems(firstManifest);

    expect(repeatedManifest.rootHash).toBe(firstManifest.rootHash);
    expect(repeatedManifest.rangeHash).toBe(firstManifest.rangeHash);
    expect(remoteSync.isManifestRangeValid(firstManifest)).toBe(true);
    expect(
      remoteSync.isManifestRangeValid({
        ...firstManifest,
        rangeHash: 'tampered-range',
      }),
    ).toBe(false);
    expect(await localSync.getEntityRootHash('post')).not.toBe(firstManifest.rootHash);
    expect(missing.map((item) => item.id)).toEqual(['missing-old']);
  });

  it('requests a divergent state even when its wall clock is older than the local state', async () => {
    const local = createPost('fork', 1_000);
    const remote = {
      ...local,
      updatedAt: 500,
      signature: 'remote-fork-signature',
      text: 'remote fork',
      contentHash: 'remote-fork-hash',
    };
    const trustedPeers = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    const localSync = new IncrementalSyncService(
      'local-peer',
      createPostRepository([local]) as never,
      trustedPeers,
      10,
    );
    const remoteSync = new IncrementalSyncService(
      'peer-b',
      createPostRepository([remote]) as never,
      trustedPeers,
      10,
    );

    const manifest = await remoteSync.createEntityManifest('post');

    await expect(localSync.findMissingManifestItems(manifest)).resolves.toEqual([
      expect.objectContaining({ id: 'fork' }),
    ]);
  });

  it('propagates a v2 page persistence failure instead of acknowledging a partial page', async () => {
    const repository = createPostRepository();
    repository.create = async () => {
      throw new AppError({
        code: 'STORAGE_ERROR',
        message: 'storage unavailable',
        retryable: false,
      });
    };
    const trustedPeers = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    const sync = new IncrementalSyncService('local-peer', repository as never, trustedPeers, 10);

    await expect(
      sync.applyBatch('peer-b', {
        version: 2,
        peerId: 'peer-b',
        entity: 'post',
        itemIds: ['post-a'],
        hasMore: false,
        posts: [createPost('post-a', 100)],
      }),
    ).rejects.toThrow('storage unavailable');
  });

  it('reads tombstones from the persisted post repository used by the runtime', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    const posts = new PostRepository(database);
    const active = {
      ...createPost('persisted-post', 100),
      revision: 2,
      previousRevisionHash: 'a'.repeat(64),
    };
    await posts.create(active);
    await posts.update({
      ...active,
      updatedAt: 200,
      signature: 'sig-persisted-post-deleted',
      deleted: true,
    });
    const trustedPeers = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    const sync = new IncrementalSyncService('local-peer', posts, trustedPeers, 10);

    const manifest = await sync.createEntityManifest('post');

    expect(await posts.getAll()).toEqual([]);
    expect(manifest.items).toEqual([
      expect.objectContaining({ id: 'persisted-post', deleted: true, updatedAt: 200 }),
    ]);
    await expect(posts.getById('persisted-post')).resolves.toMatchObject({
      revision: 2,
      previousRevisionHash: 'a'.repeat(64),
    });
    await database.close();
  });
});
