import type { ChatMessageData } from '@/models/ChatMessage';
import type { CommentData } from '@/models/Comment';
import type { FollowData } from '@/models/Follow';
import type { PostData } from '@/models/Post';
import type { ReactionData } from '@/models/Reaction';
import type { PeerId } from '@/network/NetworkTypes';

export type SocialNotificationType = 'follower' | 'comment' | 'reaction' | 'chat' | 'post';

export interface SocialNotificationItem {
  id: string;
  type: SocialNotificationType;
  title: string;
  message: string;
  actorId: PeerId;
  timestamp: number;
  read: boolean;
  targetRoute: '/profile/[author]' | '/feed' | '/chat';
  targetParams?: Record<string, string>;
  primaryAction: string;
  followBackPeerId?: PeerId;
  followingBack?: boolean;
}

export interface SocialNotificationSourceData {
  localPeerId: PeerId;
  ownPosts: PostData[];
  followers: FollowData[];
  following: FollowData[];
  comments: CommentData[];
  reactions: ReactionData[];
  chatMessages: ChatMessageData[];
  remotePosts: PostData[];
  readIds?: ReadonlySet<string>;
  hiddenIds?: ReadonlySet<string>;
}

export function buildSocialNotifications(
  input: SocialNotificationSourceData,
): SocialNotificationItem[] {
  const readIds = input.readIds ?? new Set<string>();
  const hiddenIds = input.hiddenIds ?? new Set<string>();
  const ownPostIds = new Set(input.ownPosts.map((post) => post.id));
  const followingPeerIds = new Set(
    input.following.filter((follow) => !follow.deleted).map((follow) => follow.followingId),
  );
  const items: SocialNotificationItem[] = [];

  for (const follow of input.followers) {
    if (follow.deleted || follow.followerId === input.localPeerId) {
      continue;
    }
    items.push({
      id: `notification:follower:${follow.id}`,
      type: 'follower',
      title: 'Novo seguidor',
      message: `${shortPeer(follow.followerId)} comecou a seguir voce.`,
      actorId: follow.followerId,
      timestamp: follow.updatedAt,
      read: false,
      targetRoute: '/profile/[author]',
      targetParams: { author: follow.followerId },
      primaryAction: 'Ver perfil',
      followBackPeerId: follow.followerId,
      followingBack: followingPeerIds.has(follow.followerId),
    });
  }

  for (const comment of input.comments) {
    if (
      comment.deleted ||
      comment.author === input.localPeerId ||
      !ownPostIds.has(comment.postId)
    ) {
      continue;
    }
    items.push({
      id: `notification:comment:${comment.id}`,
      type: 'comment',
      title: 'Novo comentario',
      message: `${shortPeer(comment.author)} comentou no seu post: "${truncate(comment.text)}"`,
      actorId: comment.author,
      timestamp: comment.updatedAt,
      read: false,
      targetRoute: '/feed',
      primaryAction: 'Abrir feed',
    });
  }

  for (const reaction of input.reactions) {
    if (
      reaction.deleted ||
      reaction.author === input.localPeerId ||
      !ownPostIds.has(reaction.postId)
    ) {
      continue;
    }
    items.push({
      id: `notification:reaction:${reaction.id}`,
      type: 'reaction',
      title: 'Nova curtida',
      message: `${shortPeer(reaction.author)} curtiu seu post.`,
      actorId: reaction.author,
      timestamp: reaction.updatedAt,
      read: false,
      targetRoute: '/feed',
      primaryAction: 'Abrir feed',
    });
  }

  for (const message of input.chatMessages) {
    if (
      message.deleted ||
      message.relayOnly ||
      message.senderId === input.localPeerId ||
      message.recipientId !== input.localPeerId
    ) {
      continue;
    }
    items.push({
      id: `notification:chat:${message.id}`,
      type: 'chat',
      title: 'Nova mensagem',
      message: `${shortPeer(message.senderId)} enviou: "${truncate(message.text)}"`,
      actorId: message.senderId,
      timestamp: message.updatedAt,
      read: false,
      targetRoute: '/chat',
      primaryAction: 'Abrir mensagens',
    });
  }

  for (const post of input.remotePosts) {
    if (post.deleted || post.author === input.localPeerId) {
      continue;
    }
    items.push({
      id: `notification:post:${post.id}`,
      type: 'post',
      title: 'Post sincronizado',
      message: `${shortPeer(post.author)} publicou: "${truncate(post.text || 'midia anexada')}"`,
      actorId: post.author,
      timestamp: post.updatedAt,
      read: false,
      targetRoute: '/feed',
      primaryAction: 'Abrir feed',
    });
  }

  return items
    .filter((item) => !hiddenIds.has(item.id))
    .map((item) => ({ ...item, read: readIds.has(item.id) }))
    .sort((left, right) => right.timestamp - left.timestamp);
}

function shortPeer(peerId: string): string {
  return peerId.length <= 16 ? peerId : `${peerId.slice(0, 8)}...${peerId.slice(-6)}`;
}

function truncate(value: string): string {
  const text = value.trim();
  return text.length <= 80 ? text : `${text.slice(0, 77)}...`;
}
