import type { ChatMessageData } from '@/models/ChatMessage';
import type { CommentData } from '@/models/Comment';
import type { FollowData } from '@/models/Follow';
import type { PostData } from '@/models/Post';
import type { ReactionData } from '@/models/Reaction';
import type { PeerId } from '@/network/NetworkTypes';

import { buildSocialNotifications } from '../SocialNotificationModel';

const localPeerId = 'peer-local' as PeerId;
const remotePeerId = 'peer-remote' as PeerId;

describe('SocialNotificationInbox', () => {
  it('builds inbox items from persisted social data', () => {
    const notifications = buildSocialNotifications({
      localPeerId,
      ownPosts: [createPost('post-1', localPeerId, 'hello')],
      followers: [createFollow(remotePeerId, localPeerId)],
      following: [],
      comments: [createComment('comment-1', remotePeerId, 'post-1', 'nice post')],
      reactions: [createReaction('reaction-1', remotePeerId, 'post-1')],
      chatMessages: [createChatMessage('chat-1', remotePeerId, localPeerId, 'oi')],
      remotePosts: [createPost('post-remote', remotePeerId, 'remote post')],
      readIds: new Set(['notification:reaction:reaction-1']),
      hiddenIds: new Set(['notification:post:post-remote']),
    });

    expect(notifications.map((item) => item.type)).toEqual([
      'chat',
      'reaction',
      'comment',
      'follower',
    ]);
    expect(notifications.find((item) => item.type === 'reaction')?.read).toBe(true);
    expect(notifications.some((item) => item.id === 'notification:post:post-remote')).toBe(false);
  });

  it('does not notify for local actors or interactions on remote posts', () => {
    const notifications = buildSocialNotifications({
      localPeerId,
      ownPosts: [createPost('post-1', localPeerId, 'mine')],
      followers: [createFollow(localPeerId, remotePeerId)],
      following: [],
      comments: [
        createComment('comment-local', localPeerId, 'post-1', 'self'),
        createComment('comment-remote-post', remotePeerId, 'post-remote', 'not mine'),
      ],
      reactions: [
        createReaction('reaction-local', localPeerId, 'post-1'),
        createReaction('reaction-remote-post', remotePeerId, 'post-remote'),
      ],
      chatMessages: [createChatMessage('chat-sent', localPeerId, remotePeerId, 'sent')],
      remotePosts: [],
    });

    expect(notifications).toEqual([]);
  });
});

function createPost(id: string, author: PeerId, text: string): PostData {
  return {
    id,
    author,
    createdAt: 100,
    updatedAt: 100,
    signature: 'signature',
    version: '2.0.0',
    text,
    contentHash: `hash-${id}`,
    deleted: false,
  };
}

function createFollow(followerId: PeerId, followingId: PeerId): FollowData {
  return {
    id: `follow_${followerId}_${followingId}`,
    author: followerId,
    createdAt: 110,
    updatedAt: 110,
    signature: 'signature',
    version: '2.0.0',
    followerId,
    followingId,
    deleted: false,
  };
}

function createComment(id: string, author: PeerId, postId: string, text: string): CommentData {
  return {
    id,
    author,
    createdAt: 120,
    updatedAt: 120,
    signature: 'signature',
    version: '2.0.0',
    postId,
    text,
    contentHash: `hash-${id}`,
    deleted: false,
  };
}

function createReaction(id: string, author: PeerId, postId: string): ReactionData {
  return {
    id,
    author,
    createdAt: 130,
    updatedAt: 130,
    signature: 'signature',
    version: '2.0.0',
    postId,
    reactionType: 'like',
    deleted: false,
  };
}

function createChatMessage(
  id: string,
  senderId: PeerId,
  recipientId: PeerId,
  text: string,
): ChatMessageData {
  return {
    id,
    author: senderId,
    createdAt: 140,
    updatedAt: 140,
    signature: 'signature',
    version: '2.0.0',
    conversationId: [senderId, recipientId].sort().join(':'),
    senderId,
    recipientId,
    text,
    contentHash: `hash-${id}`,
    deleted: false,
  };
}
