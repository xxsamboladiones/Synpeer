import { openDatabaseService } from '@/database/sqliteAdapter.web';
import type { PeerId } from '@/network/NetworkTypes';

import { ChatMessageRepository } from '../ChatMessageRepository';
import { CommentRepository } from '../CommentRepository';
import { FollowRepository } from '../FollowRepository';
import { PostRepository } from '../PostRepository';
import { ProfileRepository } from '../ProfileRepository';
import { ReactionRepository } from '../ReactionRepository';

const PEER_A = 'peer-a' as PeerId;
const PEER_B = 'peer-b' as PeerId;
const PREVIOUS_HASH = 'a'.repeat(64);

describe('social revision persistence', () => {
  it('round-trips revision metadata through every social repository', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    const posts = new PostRepository(database);
    const profiles = new ProfileRepository(database);
    const follows = new FollowRepository(database);
    const comments = new CommentRepository(database);
    const reactions = new ReactionRepository(database);
    const chats = new ChatMessageRepository(database);

    await posts.create({
      id: 'post-1',
      author: PEER_A,
      createdAt: 1,
      updatedAt: 1,
      signature: 'post-v1',
      version: '2.0.0',
      revision: 1,
      text: 'post',
      contentHash: 'post-hash',
      mediaAttachments: [],
      deleted: false,
    });
    const persistedPost = await posts.getById('post-1');
    if (!persistedPost) {
      throw new Error('Post fixture was not persisted');
    }
    const post = {
      ...persistedPost,
      updatedAt: 2,
      signature: 'post-v2',
      revision: 2,
      previousRevisionHash: PREVIOUS_HASH,
      text: 'post edited',
    };
    await posts.update(post);

    await profiles.create({
      id: `profile_${PEER_A}`,
      author: PEER_A,
      createdAt: 1,
      updatedAt: 2,
      signature: 'profile-v2',
      version: '2.0.0',
      revision: 2,
      previousRevisionHash: PREVIOUS_HASH,
      username: 'peer_a',
      displayName: 'Peer A',
      postCount: 0,
      followerCount: 0,
      followingCount: 0,
    });
    await follows.create({
      id: `follow_${PEER_A}_${PEER_B}`,
      author: PEER_A,
      createdAt: 1,
      updatedAt: 2,
      signature: 'follow-v2',
      version: '2.0.0',
      revision: 2,
      previousRevisionHash: PREVIOUS_HASH,
      followerId: PEER_A,
      followingId: PEER_B,
      deleted: true,
    });
    await comments.create({
      id: 'comment-1',
      author: PEER_A,
      createdAt: 1,
      updatedAt: 2,
      signature: 'comment-v2',
      version: '2.0.0',
      revision: 2,
      previousRevisionHash: PREVIOUS_HASH,
      postId: 'post-1',
      text: 'comment',
      contentHash: 'comment-hash',
      deleted: false,
    });
    await reactions.create({
      id: 'reaction-1',
      author: PEER_A,
      createdAt: 1,
      updatedAt: 2,
      signature: 'reaction-v2',
      version: '2.0.0',
      revision: 2,
      previousRevisionHash: PREVIOUS_HASH,
      postId: 'post-1',
      reactionType: 'like',
      deleted: false,
    });
    await chats.create({
      id: 'chat-1',
      author: PEER_A,
      createdAt: 1,
      updatedAt: 2,
      signature: 'chat-v2',
      version: '2.0.0',
      revision: 2,
      previousRevisionHash: PREVIOUS_HASH,
      conversationId: `${PEER_A}:${PEER_B}`,
      senderId: PEER_A,
      recipientId: PEER_B,
      text: 'private message',
      contentHash: 'chat-hash',
      deleted: false,
    });

    const restored = await Promise.all([
      posts.getById('post-1'),
      profiles.getByAuthor(PEER_A),
      follows.getById(`follow_${PEER_A}_${PEER_B}`),
      comments.getById('comment-1'),
      reactions.getById('reaction-1'),
      chats.getById('chat-1'),
    ]);
    for (const record of restored) {
      expect(record).toMatchObject({
        revision: 2,
        previousRevisionHash: PREVIOUS_HASH,
      });
    }
    await database.close();
  });

  it('updates profile projections without mutating signed revision metadata', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    const profiles = new ProfileRepository(database);
    await profiles.create({
      id: `profile_${PEER_A}`,
      author: PEER_A,
      createdAt: 10,
      updatedAt: 20,
      signature: 'signed-profile',
      version: '3.0.0',
      revision: 3,
      previousRevisionHash: PREVIOUS_HASH,
      username: 'peer_a',
      displayName: 'Peer A',
      postCount: 0,
      followerCount: 0,
      followingCount: 0,
    });

    await profiles.incrementPostCount(PEER_A);
    await profiles.incrementFollowerCount(PEER_A);
    await profiles.incrementFollowingCount(PEER_A);

    await expect(profiles.getByAuthor(PEER_A)).resolves.toMatchObject({
      updatedAt: 20,
      signature: 'signed-profile',
      revision: 3,
      previousRevisionHash: PREVIOUS_HASH,
      postCount: 1,
      followerCount: 1,
      followingCount: 1,
    });
    await database.close();
  });
});
