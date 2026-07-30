import type { ChatMessageData } from '@/models/ChatMessage';
import type { PrivateMessageCiphertext } from '@/crypto/CryptoTypes';
import { openDatabaseService } from '@/database/sqliteAdapter.web';
import type { CommentData } from '@/models/Comment';
import type { FollowData } from '@/models/Follow';
import type { PostData } from '@/models/Post';
import type { ProfileData } from '@/models/Profile';
import type { ReactionData } from '@/models/Reaction';
import { createNetworkMessage } from '@/network/NetworkMessage';
import { InMemoryPeerTransport } from '@/network/PeerTransport';
import type { PeerId } from '@/network/NetworkTypes';
import { decodeUtf8, encodeUtf8, sha256Hex } from '@/utils/hash';

import {
  SocialApplicationService,
  type SocialCryptoProvider,
  type SocialChatMessageStore,
  type SocialCommentStore,
  type SocialFollowStore,
  type SocialPostStore,
  type SocialProfileStore,
  type SocialReactionStore,
} from '../SocialApplicationService';
import { SocialReplicationService } from '../SocialReplicationService';
import { SocialReplicationQueueRepository } from '../SocialReplicationQueueRepository';
import {
  createUnsignedChatDeliveryReceipt,
  getChatDeliveryReceiptSignableBytes,
} from '../PrivateChatProtocol';
import {
  getLegacyProfileSignableBytes,
  getProfileSignableBytes,
  createUnsignedPostRevision,
  getPostSignableBytes,
  getPostStateHash,
  PROFILE_MODEL_VERSION,
} from '../SocialCanonical';

class MemoryPostStore implements SocialPostStore {
  private readonly posts = new Map<string, PostData>();

  async create(post: PostData): Promise<void> {
    this.posts.set(post.id, post);
  }

  async update(post: PostData): Promise<void> {
    this.posts.set(post.id, post);
  }

  async getById(id: string): Promise<PostData | null> {
    return this.posts.get(id) ?? null;
  }

  async getByContentHash(contentHash: string): Promise<PostData[]> {
    return Array.from(this.posts.values()).filter((post) => post.contentHash === contentHash);
  }
}

class MemoryProfileStore implements SocialProfileStore {
  private readonly profiles = new Map<string, ProfileData>();

  async create(profile: ProfileData): Promise<void> {
    this.profiles.set(profile.author, profile);
  }

  async update(profile: ProfileData): Promise<void> {
    this.profiles.set(profile.author, profile);
  }

  async getByAuthor(author: string): Promise<ProfileData | null> {
    return this.profiles.get(author) ?? null;
  }
}

class MemoryCommentStore implements SocialCommentStore {
  private readonly comments = new Map<string, CommentData>();

  async create(comment: CommentData): Promise<void> {
    this.comments.set(comment.id, comment);
  }

  async update(comment: CommentData): Promise<void> {
    this.comments.set(comment.id, comment);
  }

  async getById(id: string): Promise<CommentData | null> {
    return this.comments.get(id) ?? null;
  }

  async getByContentHash(contentHash: string): Promise<CommentData[]> {
    return Array.from(this.comments.values()).filter(
      (comment) => comment.contentHash === contentHash,
    );
  }
}

class MemoryReactionStore implements SocialReactionStore {
  private readonly reactions = new Map<string, ReactionData>();

  async create(reaction: ReactionData): Promise<void> {
    this.reactions.set(reaction.id, reaction);
  }

  async update(reaction: ReactionData): Promise<void> {
    this.reactions.set(reaction.id, reaction);
  }

  async getById(id: string): Promise<ReactionData | null> {
    return this.reactions.get(id) ?? null;
  }
}

class MemoryFollowStore implements SocialFollowStore {
  private readonly follows = new Map<string, FollowData>();

  async create(follow: FollowData): Promise<void> {
    this.follows.set(follow.id, follow);
  }

  async update(follow: FollowData): Promise<void> {
    this.follows.set(follow.id, follow);
  }

  async getById(id: string): Promise<FollowData | null> {
    return this.follows.get(id) ?? null;
  }

  async getByPeers(followerId: string, followingId: string): Promise<FollowData | null> {
    return this.follows.get(`follow_${followerId}_${followingId}`) ?? null;
  }
}

class MemoryChatMessageStore implements SocialChatMessageStore {
  private readonly messages = new Map<string, ChatMessageData>();

  async create(message: ChatMessageData): Promise<void> {
    this.messages.set(message.id, message);
  }

  async update(message: ChatMessageData): Promise<void> {
    this.messages.set(message.id, message);
  }

  async getById(id: string): Promise<ChatMessageData | null> {
    return this.messages.get(id) ?? null;
  }

  async getByContentHash(contentHash: string): Promise<ChatMessageData[]> {
    return Array.from(this.messages.values()).filter(
      (message) => message.contentHash === contentHash,
    );
  }

  async getConversation(conversationId: string): Promise<ChatMessageData[]> {
    return Array.from(this.messages.values()).filter(
      (message) =>
        message.conversationId === conversationId && !message.deleted && !message.relayOnly,
    );
  }

  async getVisibleConversation(left: PeerId, right: PeerId): Promise<ChatMessageData[]> {
    const conversationId = [left, right].sort().join(':');
    return await this.getConversation(conversationId);
  }
}

class TestCrypto implements SocialCryptoProvider {
  constructor(private readonly identity: PeerId) {}

  loadIdentity(): string {
    return this.identity;
  }

  async sign(data: string): Promise<string> {
    return sha256Hex(`${this.identity}:${data}`);
  }

  async verify(data: string, signature: string, publicIdentity: string): Promise<boolean> {
    return signature === sha256Hex(`${publicIdentity}:${data}`);
  }

  async encryptForPeer(
    peerPublicIdentity: string,
    plaintext: string,
    context: string,
  ): Promise<PrivateMessageCiphertext> {
    return {
      version: 1,
      algorithm: 'x25519-aes-256-gcm',
      ciphertext: bytesToHex(encodeUtf8(plaintext)),
      nonce: sha256Hex(`${peerPublicIdentity}:${context}`).slice(0, 24),
    };
  }

  async decryptFromPeer(
    peerPublicIdentity: string,
    encrypted: PrivateMessageCiphertext,
    context: string,
  ): Promise<string> {
    if (!peerPublicIdentity || !context) {
      throw new Error('Missing private message context');
    }
    return decodeUtf8(hexToBytes(encrypted.ciphertext));
  }
}

function createPeer(peerId: PeerId): {
  posts: MemoryPostStore;
  profiles: MemoryProfileStore;
  comments: MemoryCommentStore;
  reactions: MemoryReactionStore;
  follows: MemoryFollowStore;
  chatMessages: MemoryChatMessageStore;
  transport: InMemoryPeerTransport;
  replication: SocialReplicationService;
  queue: SocialReplicationQueueRepository | null;
  service: SocialApplicationService;
  mediaSync: { ensurePostMediaAvailable: jest.Mock };
} {
  const posts = new MemoryPostStore();
  const profiles = new MemoryProfileStore();
  const comments = new MemoryCommentStore();
  const reactions = new MemoryReactionStore();
  const follows = new MemoryFollowStore();
  const chatMessages = new MemoryChatMessageStore();
  const transport = new InMemoryPeerTransport(peerId);
  const mediaSync = { ensurePostMediaAvailable: jest.fn(async () => undefined) };
  const replication = new SocialReplicationService(
    peerId,
    () => transport,
    () => transport.getConnectedPeers(),
  );
  const service = new SocialApplicationService(
    posts,
    profiles,
    new TestCrypto(peerId),
    replication,
    comments,
    reactions,
    follows,
    mediaSync,
    chatMessages,
  );
  transport.subscribe(async (message, connection) => {
    if (await replication.handleAck(message, connection.peerId)) {
      return;
    }
    await service.handleRemoteMessage(message, connection);
  });
  return {
    posts,
    profiles,
    comments,
    reactions,
    follows,
    chatMessages,
    transport,
    replication,
    queue: null,
    service,
    mediaSync,
  };
}

async function createQueuedPeer(peerId: PeerId): Promise<ReturnType<typeof createPeer>> {
  const posts = new MemoryPostStore();
  const profiles = new MemoryProfileStore();
  const comments = new MemoryCommentStore();
  const reactions = new MemoryReactionStore();
  const follows = new MemoryFollowStore();
  const chatMessages = new MemoryChatMessageStore();
  const transport = new InMemoryPeerTransport(peerId);
  const mediaSync = { ensurePostMediaAvailable: jest.fn(async () => undefined) };
  const queue = new SocialReplicationQueueRepository(
    await openDatabaseService({ forceMemory: true }),
  );
  const replication = new SocialReplicationService(
    peerId,
    () => transport,
    () => transport.getConnectedPeers(),
    queue,
  );
  const service = new SocialApplicationService(
    posts,
    profiles,
    new TestCrypto(peerId),
    replication,
    comments,
    reactions,
    follows,
    mediaSync,
    chatMessages,
  );
  transport.subscribe(async (message, connection) => {
    if (await replication.handleAck(message, connection.peerId)) {
      return;
    }
    await service.handleRemoteMessage(message, connection);
  });
  return {
    posts,
    profiles,
    comments,
    reactions,
    follows,
    chatMessages,
    transport,
    replication,
    queue,
    service,
    mediaSync,
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

describe('SocialApplicationService', () => {
  it('persists a signed post locally before replicating it to connected peers', async () => {
    const peerA = createPeer('peer-a' as PeerId);
    const peerB = createPeer('peer-b' as PeerId);
    await peerA.transport.connect(peerB.transport);

    const result = await peerA.service.createPost({ text: 'hello distributed social' });

    expect(result.persisted).toBe(true);
    expect(result.replication.successfulPeers).toEqual(['peer-b']);
    await expect(peerA.posts.getById(result.post.id)).resolves.toMatchObject({
      text: 'hello distributed social',
      author: 'peer-a',
    });
    await expect(peerB.posts.getById(result.post.id)).resolves.toMatchObject({
      text: 'hello distributed social',
      author: 'peer-a',
      signature: result.post.signature,
    });
  });

  it('keeps oversized social replication local instead of throwing through WebRTC', async () => {
    const peerA = createPeer('peer-a' as PeerId);
    const peerB = createPeer('peer-b' as PeerId);
    await peerA.transport.connect(peerB.transport);

    const result = await peerA.service.createPost({ text: 'x'.repeat(300 * 1024) });

    expect(result.persisted).toBe(true);
    expect(result.replication.successfulPeers).toEqual([]);
    expect(result.replication.failedPeers).toEqual([
      { peerId: 'peer-b', errorCode: 'NETWORK_MESSAGE_TOO_LARGE' },
    ]);
    await expect(peerA.posts.getById(result.post.id)).resolves.toMatchObject({
      text: 'x'.repeat(300 * 1024),
      author: 'peer-a',
    });
    await expect(peerB.posts.getById(result.post.id)).resolves.toBeNull();
  });

  it('edits an authored post as a signed newer revision and replicates it', async () => {
    const peerA = createPeer('peer-a' as PeerId);
    const peerB = createPeer('peer-b' as PeerId);
    await peerA.transport.connect(peerB.transport);

    const created = await peerA.service.createPost({ text: 'original post' });
    const edited = await peerA.service.editPost({
      postId: created.post.id,
      text: 'edited post',
    });

    expect(edited.post.id).toBe(created.post.id);
    expect(edited.post.contentHash).not.toBe(created.post.contentHash);
    expect(edited.post.signature).not.toBe(created.post.signature);
    expect(edited.replication.successfulPeers).toEqual(['peer-b']);
    await expect(peerA.posts.getById(created.post.id)).resolves.toMatchObject({
      text: 'edited post',
      deleted: false,
      signature: edited.post.signature,
    });
    await expect(peerB.posts.getById(created.post.id)).resolves.toMatchObject({
      text: 'edited post',
      deleted: false,
      signature: edited.post.signature,
    });
  });

  it('soft deletes an authored post as a signed tombstone and replicates it', async () => {
    const peerA = createPeer('peer-a' as PeerId);
    const peerB = createPeer('peer-b' as PeerId);
    await peerA.transport.connect(peerB.transport);

    const created = await peerA.service.createPost({ text: 'remove me' });
    const deleted = await peerA.service.deletePost({ postId: created.post.id });

    expect(deleted.post.id).toBe(created.post.id);
    expect(deleted.post.deleted).toBe(true);
    expect(deleted.post.text).toBe('');
    expect(deleted.replication.successfulPeers).toEqual(['peer-b']);
    await expect(peerB.posts.getById(created.post.id)).resolves.toMatchObject({
      deleted: true,
      text: '',
      signature: deleted.post.signature,
    });
  });

  it('prevents a local peer from editing or deleting a remote authored post', async () => {
    const peerA = createPeer('peer-a' as PeerId);
    const peerB = createPeer('peer-b' as PeerId);
    await peerA.transport.connect(peerB.transport);

    const created = await peerA.service.createPost({ text: 'owned by peer a' });

    await expect(
      peerB.service.editPost({ postId: created.post.id, text: 'hijacked' }),
    ).rejects.toThrow('Only the post author can edit this post');
    await expect(peerB.service.deletePost({ postId: created.post.id })).rejects.toThrow(
      'Only the post author can delete this post',
    );
  });

  it('persists replication while offline and delivers it after a trusted peer connects', async () => {
    const peerA = await createQueuedPeer('peer-a' as PeerId);
    const peerB = createPeer('peer-b' as PeerId);

    const result = await peerA.service.createPost({ text: 'offline first post' });

    expect(result.replication).toEqual({
      attemptedPeers: 0,
      successfulPeers: [],
      failedPeers: [],
    });
    await expect(peerA.queue?.getStatus()).resolves.toMatchObject({ pending: 1, acked: 0 });
    await expect(peerB.posts.getById(result.post.id)).resolves.toBeNull();

    await peerA.transport.connect(peerB.transport);
    const replay = await peerA.replication.processPendingQueue();

    expect(replay.successfulPeers).toEqual(['peer-b']);
    await expect(peerA.queue?.getStatus()).resolves.toMatchObject({ pending: 0, acked: 1 });
    await expect(peerB.posts.getById(result.post.id)).resolves.toMatchObject({
      id: result.post.id,
      text: 'offline first post',
    });
  });

  it('deduplicates repeated local creates by deterministic content hash', async () => {
    const peer = createPeer('peer-a' as PeerId);

    const first = await peer.service.createPost({ text: 'same content' });
    const second = await peer.service.createPost({ text: 'same content' });

    expect(second.post.id).toBe(first.post.id);
    expect(second.post.signature).toBe(first.post.signature);
    expect(await peer.posts.getByContentHash(first.post.contentHash)).toHaveLength(1);
  });

  it('rejects remote posts with invalid signatures', async () => {
    const peerA = createPeer('peer-a' as PeerId);
    const peerB = createPeer('peer-b' as PeerId);

    const result = await peerA.service.createPost({ text: 'tamper target' });
    const tampered = { ...result.post, signature: 'invalid-signature' };

    await expect(peerB.service.applyRemotePost(tampered, 'peer-a')).rejects.toThrow(
      'Remote post signature is invalid',
    );
  });

  it('skips remote posts that fail canonical integrity instead of crashing sync', async () => {
    const peerA = createPeer('peer-a' as PeerId);
    const peerB = createPeer('peer-b' as PeerId);

    const result = await peerA.service.createPost({ text: 'legacy shape' });
    const legacyPost = {
      ...result.post,
      id: 'post_legacy_non_canonical',
      contentHash: 'legacy-hash',
    };

    await expect(peerB.service.applyRemotePost(legacyPost, 'peer-a')).resolves.toEqual({
      applied: false,
      skipped: true,
      conflict: false,
    });
    await expect(peerB.posts.getById(legacyPost.id)).resolves.toBeNull();
  });

  it('replicates signed profile updates to connected peers', async () => {
    const peerA = createPeer('peer-a' as PeerId);
    const peerB = createPeer('peer-b' as PeerId);
    await peerA.transport.connect(peerB.transport);

    const result = await peerA.service.updateLocalProfile({
      displayName: 'Alice',
      username: 'alice',
      bio: 'Local-first profile',
    });

    expect(result.replication.successfulPeers).toEqual(['peer-b']);
    await expect(peerB.profiles.getByAuthor('peer-a')).resolves.toMatchObject({
      displayName: 'Alice',
      username: 'alice',
      signature: result.profile.signature,
    });
  });

  it('keeps profile counters as local projections outside the current signature', async () => {
    const peerA = createPeer('peer-a' as PeerId);
    const peerB = createPeer('peer-b' as PeerId);
    const result = await peerA.service.updateLocalProfile({
      displayName: 'Alice',
      username: 'alice',
    });

    await expect(
      peerB.service.applyRemoteProfile(
        {
          ...result.profile,
          postCount: 999,
          followerCount: 999,
          followingCount: 999,
        },
        'peer-a',
      ),
    ).resolves.toMatchObject({ applied: true });
    await expect(peerB.profiles.getByAuthor('peer-a')).resolves.toMatchObject({
      postCount: 0,
      followerCount: 0,
      followingCount: 0,
    });
  });

  it('accepts a valid legacy profile signature during the migration window', async () => {
    const peerB = createPeer('peer-b' as PeerId);
    const crypto = new TestCrypto('peer-a' as PeerId);
    const legacyProfile: ProfileData = {
      id: 'profile_peer-a',
      author: 'peer-a' as PeerId,
      createdAt: 100,
      updatedAt: 100,
      signature: '',
      version: '2.0.0',
      revision: 1,
      username: 'alice',
      displayName: 'Alice',
      postCount: 2,
      followerCount: 3,
      followingCount: 4,
    };
    legacyProfile.signature = await crypto.sign(getLegacyProfileSignableBytes(legacyProfile));

    await expect(peerB.service.applyRemoteProfile(legacyProfile, 'peer-a')).resolves.toMatchObject({
      applied: true,
    });
  });

  it('accepts the transitional current-version signature that included local projections', async () => {
    const peerB = createPeer('peer-b' as PeerId);
    const crypto = new TestCrypto('peer-a' as PeerId);
    const transitionalProfile: ProfileData = {
      id: 'profile_peer-a',
      author: 'peer-a' as PeerId,
      createdAt: 100,
      updatedAt: 200,
      signature: '',
      version: PROFILE_MODEL_VERSION,
      revision: 2,
      previousRevisionHash: 'a'.repeat(64),
      username: 'alice',
      displayName: 'Alice',
      postCount: 2,
      followerCount: 3,
      followingCount: 4,
    };
    transitionalProfile.signature = await crypto.sign(
      getLegacyProfileSignableBytes(transitionalProfile),
    );

    await expect(
      peerB.service.applyRemoteProfile(transitionalProfile, 'peer-a'),
    ).resolves.toMatchObject({
      applied: true,
    });
  });

  it('re-signs the local legacy profile with the current canonical format', async () => {
    const peerA = createPeer('peer-a' as PeerId);
    const crypto = new TestCrypto('peer-a' as PeerId);
    const legacyProfile: ProfileData = {
      id: 'profile_peer-a',
      author: 'peer-a' as PeerId,
      createdAt: 100,
      updatedAt: 200,
      signature: 'stale-after-projection-update',
      version: '2.0.0',
      revision: 1,
      username: 'alice',
      displayName: 'Alice',
      postCount: 8,
      followerCount: 5,
      followingCount: 3,
    };
    await peerA.profiles.create(legacyProfile);

    const migrated = await peerA.service.migrateLocalProfileSignature();

    expect(migrated).toMatchObject({
      version: PROFILE_MODEL_VERSION,
      revision: 2,
      postCount: 8,
      followerCount: 5,
      followingCount: 3,
    });
    if (!migrated) {
      throw new Error('Expected the legacy profile to be migrated');
    }
    expect(
      await crypto.verify(getProfileSignableBytes(migrated), migrated.signature, 'peer-a'),
    ).toBe(true);
  });

  it('re-signs a transitional current-version local profile during bootstrap migration', async () => {
    const peerA = createPeer('peer-a' as PeerId);
    const crypto = new TestCrypto('peer-a' as PeerId);
    const transitionalProfile: ProfileData = {
      id: 'profile_peer-a',
      author: 'peer-a' as PeerId,
      createdAt: 100,
      updatedAt: 200,
      signature: '',
      version: PROFILE_MODEL_VERSION,
      revision: 2,
      previousRevisionHash: 'a'.repeat(64),
      username: 'alice',
      displayName: 'Alice',
      postCount: 8,
      followerCount: 5,
      followingCount: 3,
    };
    transitionalProfile.signature = await crypto.sign(
      getLegacyProfileSignableBytes(transitionalProfile),
    );
    await peerA.profiles.create(transitionalProfile);

    const migrated = await peerA.service.migrateLocalProfileSignature();

    expect(migrated).toMatchObject({
      version: PROFILE_MODEL_VERSION,
      revision: 3,
      postCount: 8,
      followerCount: 5,
      followingCount: 3,
    });
    if (!migrated) {
      throw new Error('Expected the transitional profile to be migrated');
    }
    expect(
      await crypto.verify(getProfileSignableBytes(migrated), migrated.signature, 'peer-a'),
    ).toBe(true);
  });

  it('replicates signed comments, reactions and follows to connected peers', async () => {
    const peerA = createPeer('peer-a' as PeerId);
    const peerB = createPeer('peer-b' as PeerId);
    await peerA.transport.connect(peerB.transport);

    const commentResult = await peerA.service.createComment({
      postId: 'post-1',
      text: 'real comment',
    });
    const reactionResult = await peerA.service.createReaction({
      postId: 'post-1',
    });
    const followResult = await peerA.service.createFollow({
      followingId: 'peer-b' as PeerId,
    });

    expect(commentResult.replication.successfulPeers).toEqual(['peer-b']);
    expect(reactionResult.replication.successfulPeers).toEqual(['peer-b']);
    expect(followResult.replication.successfulPeers).toEqual(['peer-b']);
    await expect(peerB.comments.getById(commentResult.comment.id)).resolves.toMatchObject({
      text: 'real comment',
      signature: commentResult.comment.signature,
    });
    await expect(peerB.reactions.getById(reactionResult.reaction.id)).resolves.toMatchObject({
      postId: 'post-1',
      signature: reactionResult.reaction.signature,
    });
    await expect(peerB.follows.getById(followResult.follow.id)).resolves.toMatchObject({
      followerId: 'peer-a',
      followingId: 'peer-b',
      signature: followResult.follow.signature,
    });
  });

  it('emits a remote follow event when a follow reaches the followed peer', async () => {
    const peerA = createPeer('peer-a' as PeerId);
    const peerB = createPeer('peer-b' as PeerId);
    await peerA.transport.connect(peerB.transport);
    const observed: string[] = [];
    peerB.service.events.subscribe((event) => {
      if (event.type === 'social.follow.persisted') {
        observed.push(`${event.origin}:${event.followerId}->${event.followingId}`);
      }
    });

    await peerA.service.createFollow({
      followingId: 'peer-b' as PeerId,
    });

    expect(observed).toEqual(['remote:peer-a->peer-b']);
  });

  it('replicates signed unfollows and can reactivate the deterministic follow id', async () => {
    const peerA = createPeer('peer-a' as PeerId);
    const peerB = createPeer('peer-b' as PeerId);
    await peerA.transport.connect(peerB.transport);

    const followResult = await peerA.service.createFollow({
      followingId: 'peer-b' as PeerId,
    });
    const unfollowResult = await peerA.service.createUnfollow({
      followingId: 'peer-b' as PeerId,
    });

    expect(unfollowResult.follow.id).toBe(followResult.follow.id);
    expect(unfollowResult.follow.deleted).toBe(true);
    expect(unfollowResult.replication.successfulPeers).toEqual(['peer-b']);
    await expect(peerB.follows.getById(followResult.follow.id)).resolves.toMatchObject({
      deleted: true,
      signature: unfollowResult.follow.signature,
    });

    const refollowResult = await peerA.service.createFollow({
      followingId: 'peer-b' as PeerId,
    });

    expect(refollowResult.follow.id).toBe(followResult.follow.id);
    expect(refollowResult.follow.deleted).toBe(false);
    expect(refollowResult.follow.updatedAt).toBeGreaterThan(unfollowResult.follow.updatedAt);
    await expect(peerB.follows.getById(followResult.follow.id)).resolves.toMatchObject({
      deleted: false,
      signature: refollowResult.follow.signature,
    });
  });

  it('gossips signed posts across trusted multi-hop peer chains', async () => {
    const peerA = createPeer('peer-a' as PeerId);
    const peerB = createPeer('peer-b' as PeerId);
    const peerC = createPeer('peer-c' as PeerId);
    const peerD = createPeer('peer-d' as PeerId);
    await peerA.transport.connect(peerB.transport);
    await peerB.transport.connect(peerC.transport);
    await peerC.transport.connect(peerD.transport);

    const result = await peerA.service.createPost({ text: 'multi-hop hello' });

    expect(result.replication.successfulPeers).toEqual(['peer-b']);
    await expect(peerD.posts.getById(result.post.id)).resolves.toMatchObject({
      text: 'multi-hop hello',
      author: 'peer-a',
      signature: result.post.signature,
    });
  });

  it('converges same-revision post forks independently of arrival order and clock order', async () => {
    const author = createPeer('peer-a' as PeerId);
    const leftReplica = createPeer('peer-left' as PeerId);
    const rightReplica = createPeer('peer-right' as PeerId);
    const base = (await author.service.createPost({ text: 'base' })).post;
    await leftReplica.service.applyRemotePost(base, 'peer-a');
    await rightReplica.service.applyRemotePost(base, 'peer-a');

    const crypto = new TestCrypto('peer-a' as PeerId);
    const leftUnsigned = createUnsignedPostRevision({
      previous: base,
      text: 'left branch',
      updatedAt: base.updatedAt + 10_000,
    });
    const rightUnsigned = createUnsignedPostRevision({
      previous: base,
      text: 'right branch',
      updatedAt: base.updatedAt + 2,
    });
    const left = {
      ...leftUnsigned,
      signature: await crypto.sign(getPostSignableBytes(leftUnsigned)),
    };
    const right = {
      ...rightUnsigned,
      signature: await crypto.sign(getPostSignableBytes(rightUnsigned)),
    };

    await leftReplica.service.applyRemotePost(left, 'peer-a');
    await leftReplica.service.applyRemotePost(right, 'peer-a');
    await rightReplica.service.applyRemotePost(right, 'peer-a');
    await rightReplica.service.applyRemotePost(left, 'peer-a');

    const leftWinner = await leftReplica.posts.getById(base.id);
    const rightWinner = await rightReplica.posts.getById(base.id);
    expect(leftWinner).not.toBeNull();
    expect(rightWinner).not.toBeNull();
    expect(getPostStateHash(leftWinner as PostData)).toBe(
      getPostStateHash(rightWinner as PostData),
    );
    expect(getPostStateHash(leftWinner as PostData)).toBe(
      [getPostStateHash(left), getPostStateHash(right)].sort().at(-1),
    );
  });

  it('converges edit versus delete to a final tombstone without resurrection', async () => {
    const author = createPeer('peer-a' as PeerId);
    const editFirst = createPeer('peer-edit-first' as PeerId);
    const deleteFirst = createPeer('peer-delete-first' as PeerId);
    const base = (await author.service.createPost({ text: 'base' })).post;
    await editFirst.service.applyRemotePost(base, 'peer-a');
    await deleteFirst.service.applyRemotePost(base, 'peer-a');

    const crypto = new TestCrypto('peer-a' as PeerId);
    const editUnsigned = createUnsignedPostRevision({ previous: base, text: 'edited' });
    const deleteUnsigned = createUnsignedPostRevision({ previous: base, deleted: true });
    const edit = {
      ...editUnsigned,
      signature: await crypto.sign(getPostSignableBytes(editUnsigned)),
    };
    const tombstone = {
      ...deleteUnsigned,
      signature: await crypto.sign(getPostSignableBytes(deleteUnsigned)),
    };

    await editFirst.service.applyRemotePost(edit, 'peer-a');
    await editFirst.service.applyRemotePost(tombstone, 'peer-a');
    await deleteFirst.service.applyRemotePost(tombstone, 'peer-a');
    await deleteFirst.service.applyRemotePost(edit, 'peer-a');

    await expect(editFirst.posts.getById(base.id)).resolves.toMatchObject({ deleted: true });
    await expect(deleteFirst.posts.getById(base.id)).resolves.toMatchObject({ deleted: true });
  });

  it('requests remote media chunks after applying a received post with attachments', async () => {
    const peerA = createPeer('peer-a' as PeerId);
    const peerB = createPeer('peer-b' as PeerId);
    await peerA.transport.connect(peerB.transport);

    const result = await peerA.service.createPost({
      text: 'photo',
      mediaAttachments: [
        {
          id: 'media-photo',
          type: 'image',
          mime: 'image/png',
          size: 3,
          hash: 'hash-photo',
          chunks: ['chunk-1'],
          name: 'photo.png',
        },
      ],
    });

    expect(peerB.mediaSync.ensurePostMediaAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ id: result.post.id }),
      'peer-a',
    );
    expect(peerB.mediaSync.ensurePostMediaAvailable).toHaveBeenCalledTimes(1);
  });

  it('requests remote media chunks when a post is applied through incremental sync', async () => {
    const peerA = createPeer('peer-a' as PeerId);
    const peerB = createPeer('peer-b' as PeerId);
    const result = await peerA.service.createPost({
      text: 'old photo',
      mediaAttachments: [
        {
          id: 'media-old-photo',
          type: 'image',
          mime: 'image/png',
          size: 3,
          hash: 'hash-old-photo',
          chunks: ['chunk-1'],
          name: 'old-photo.png',
        },
      ],
    });

    await peerB.service.applyRemotePost(result.post, 'peer-a');

    expect(peerB.mediaSync.ensurePostMediaAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ id: result.post.id }),
      'peer-a',
    );
  });

  it('gossips comments and reactions across trusted multi-hop peer chains', async () => {
    const peerA = createPeer('peer-a' as PeerId);
    const peerB = createPeer('peer-b' as PeerId);
    const peerC = createPeer('peer-c' as PeerId);
    const peerD = createPeer('peer-d' as PeerId);
    await peerA.transport.connect(peerB.transport);
    await peerB.transport.connect(peerC.transport);
    await peerC.transport.connect(peerD.transport);

    const commentResult = await peerA.service.createComment({
      postId: 'post-root',
      text: 'multi-hop comment',
    });
    const reactionResult = await peerA.service.createReaction({
      postId: 'post-root',
    });

    await expect(peerD.comments.getById(commentResult.comment.id)).resolves.toMatchObject({
      text: 'multi-hop comment',
      author: 'peer-a',
      signature: commentResult.comment.signature,
    });
    await expect(peerD.reactions.getById(reactionResult.reaction.id)).resolves.toMatchObject({
      postId: 'post-root',
      author: 'peer-a',
      signature: reactionResult.reaction.signature,
    });
  });

  it('routes encrypted follower chat across multiple hops without exposing plaintext to relays', async () => {
    const peerA = createPeer('peer-a' as PeerId);
    const peerB = createPeer('peer-b' as PeerId);
    const peerC = createPeer('peer-c' as PeerId);
    const peerD = createPeer('peer-d' as PeerId);
    const relayPayloads: string[] = [];
    peerB.transport.subscribe((message) => {
      if (message.messageType === 'social.chat') {
        relayPayloads.push(JSON.stringify(message.payload));
      }
    });
    await peerA.transport.connect(peerB.transport);
    await peerB.transport.connect(peerC.transport);
    await peerC.transport.connect(peerD.transport);
    await peerA.follows.create(createFollowData('peer-a' as PeerId, 'peer-d' as PeerId));

    const result = await peerA.service.createChatMessage({
      recipientId: 'peer-d' as PeerId,
      text: 'hello over the follower graph',
    });

    await expect(peerA.chatMessages.getById(result.message.id)).resolves.toMatchObject({
      text: 'hello over the follower graph',
      senderId: 'peer-a',
      recipientId: 'peer-d',
      deliveredAt: expect.any(Number),
    });
    await expect(peerD.chatMessages.getById(result.message.id)).resolves.toMatchObject({
      text: 'hello over the follower graph',
      senderId: 'peer-a',
      recipientId: 'peer-d',
      signature: result.message.signature,
      relayOnly: false,
    });
    await expect(peerB.chatMessages.getById(result.message.id)).resolves.toBeNull();
    await expect(peerC.chatMessages.getById(result.message.id)).resolves.toBeNull();
    expect(relayPayloads.join('\n')).not.toContain('hello over the follower graph');
    await expect(
      peerB.chatMessages.getVisibleConversation('peer-a' as PeerId, 'peer-d' as PeerId),
    ).resolves.toHaveLength(0);
    await expect(
      peerC.chatMessages.getVisibleConversation('peer-a' as PeerId, 'peer-d' as PeerId),
    ).resolves.toHaveLength(0);

    await expect(
      peerD.service.markConversationRead('peer-a' as PeerId, result.message.createdAt + 10),
    ).resolves.toBe(1);
    await expect(peerA.chatMessages.getById(result.message.id)).resolves.toMatchObject({
      deliveredAt: expect.any(Number),
      readAt: result.message.createdAt + 10,
    });
  });

  it('resumes an offline private chat and only completes its queue after the recipient receipt', async () => {
    const peerA = await createQueuedPeer('peer-a' as PeerId);
    const peerB = createPeer('peer-b' as PeerId);
    const peerC = createPeer('peer-c' as PeerId);
    const peerD = createPeer('peer-d' as PeerId);
    await peerA.follows.create(createFollowData('peer-a' as PeerId, 'peer-d' as PeerId));

    const result = await peerA.service.createChatMessage({
      recipientId: 'peer-d' as PeerId,
      text: 'queued while offline',
    });

    await expect(peerA.queue?.getStatus()).resolves.toMatchObject({ pending: 1, acked: 0 });
    await peerA.transport.connect(peerB.transport);
    await peerB.transport.connect(peerC.transport);
    await peerC.transport.connect(peerD.transport);

    await peerA.replication.processPendingQueue();
    await peerA.replication.processPendingQueue();

    await expect(peerD.chatMessages.getById(result.message.id)).resolves.toMatchObject({
      text: 'queued while offline',
      deliveredAt: expect.any(Number),
    });
    await expect(peerA.chatMessages.getById(result.message.id)).resolves.toMatchObject({
      deliveredAt: expect.any(Number),
    });
    await expect(peerA.queue?.getStatus()).resolves.toMatchObject({ pending: 0, failed: 0 });
    await expect(peerA.queue?.getChatDeliveryReceipt(result.message.id)).resolves.not.toBeNull();
    await expect(
      peerD.chatMessages.getVisibleConversation('peer-a' as PeerId, 'peer-d' as PeerId),
    ).resolves.toHaveLength(1);
  });

  it('rejects a final delivery receipt forged by an intermediate relay', async () => {
    const peerA = await createQueuedPeer('peer-a' as PeerId);
    const peerB = createPeer('peer-b' as PeerId);
    await peerA.follows.create(createFollowData('peer-a' as PeerId, 'peer-d' as PeerId));
    const result = await peerA.service.createChatMessage({
      recipientId: 'peer-d' as PeerId,
      text: 'must require the recipient signature',
    });
    await peerA.transport.connect(peerB.transport);

    const unsignedReceipt = createUnsignedChatDeliveryReceipt({
      messageId: result.message.id,
      senderId: 'peer-a' as PeerId,
      recipientId: 'peer-d' as PeerId,
      deliveredAt: result.message.createdAt + 1,
    });
    const forgedReceipt = {
      ...unsignedReceipt,
      signature: await new TestCrypto('peer-b' as PeerId).sign(
        getChatDeliveryReceiptSignableBytes(unsignedReceipt),
      ),
    };
    const forgedMessage = createNetworkMessage({
      messageType: 'social.chat.receipt',
      senderId: 'peer-b' as PeerId,
      payload: {
        version: 1,
        entity: 'chat-receipt',
        action: 'upsert',
        receipt: forgedReceipt,
        gossip: {
          version: 1,
          originPeerId: 'peer-b' as PeerId,
          objectId: `receipt_${result.message.id}_peer-d`,
          ttl: 8,
          path: ['peer-b' as PeerId],
        },
      },
    });

    await expect(peerB.transport.send('peer-a' as PeerId, forgedMessage)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect((await peerA.chatMessages.getById(result.message.id))?.deliveredAt).toBeUndefined();
    await expect(peerA.queue?.getStatus()).resolves.toMatchObject({
      pending: 1,
      acked: 0,
    });
    peerA.replication.stop();
  });

  it('rejects chat messages when there is no follower relationship', async () => {
    const peerA = createPeer('peer-a' as PeerId);

    await expect(
      peerA.service.createChatMessage({
        recipientId: 'peer-b' as PeerId,
        text: 'not allowed yet',
      }),
    ).rejects.toThrow('Chat requires a follower relationship');
  });
});

function createFollowData(followerId: PeerId, followingId: PeerId): FollowData {
  const now = Date.now();
  return {
    id: `follow_${followerId}_${followingId}`,
    author: followerId,
    createdAt: now,
    updatedAt: now,
    signature: `sig-${followerId}-${followingId}`,
    version: '1',
    followerId,
    followingId,
    deleted: false,
  };
}
