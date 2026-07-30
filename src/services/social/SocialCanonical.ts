import type { PostData, PostMediaAttachment } from '@/models/Post';
import { Post } from '@/models/Post';
import type { ProfileData } from '@/models/Profile';
import { Profile } from '@/models/Profile';
import type { CommentData } from '@/models/Comment';
import { Comment } from '@/models/Comment';
import type { ReactionData, ReactionType } from '@/models/Reaction';
import { Reaction } from '@/models/Reaction';
import type { FollowData } from '@/models/Follow';
import { Follow } from '@/models/Follow';
import type { ChatMessageData } from '@/models/ChatMessage';
import { getConversationId } from '@/models/ChatMessage';
import type { PeerId } from '@/network/NetworkTypes';
import { sha256Hex } from '@/utils/hash';

export const SOCIAL_MODEL_VERSION = '2.0.0';
export const PROFILE_MODEL_VERSION = '3.0.0';
const LEGACY_PROFILE_MODEL_VERSIONS = new Set(['1.0.0', '2.0.0']);

export type CanonicalPostInput = {
  author: PeerId;
  text: string;
  replyTo?: string;
  mediaAttachments?: PostMediaAttachment[];
  createdAt?: number;
};

export type CanonicalPostRevisionInput = {
  previous: PostData;
  text?: string;
  mediaAttachments?: PostMediaAttachment[];
  deleted?: boolean;
  updatedAt?: number;
};

export type CanonicalProfileInput = {
  author: PeerId;
  username: string;
  displayName: string;
  bio?: string;
  avatarHash?: string;
  createdAt?: number;
  previous?: ProfileData | null;
};

export type CanonicalCommentInput = {
  author: PeerId;
  postId: string;
  text: string;
  parentCommentId?: string;
  createdAt?: number;
};

export type CanonicalReactionInput = {
  author: PeerId;
  postId: string;
  commentId?: string;
  reactionType?: ReactionType;
  createdAt?: number;
};

export type CanonicalFollowInput = {
  followerId: PeerId;
  followingId: PeerId;
  createdAt?: number;
  previous?: FollowData | null;
  deleted?: boolean;
};

export type CanonicalChatMessageInput = {
  senderId: PeerId;
  recipientId: PeerId;
  text: string;
  createdAt?: number;
};

export function createUnsignedPost(input: CanonicalPostInput): PostData {
  const text = input.text.trim();
  const mediaAttachments = normalizeAttachments(input.mediaAttachments ?? []);
  const createdAt = input.createdAt ?? Date.now();
  const contentHash = hashPostContent({
    author: input.author,
    text,
    replyTo: input.replyTo,
    mediaAttachments,
  });
  const id = `post_${contentHash}`;

  return {
    id,
    author: input.author,
    createdAt,
    updatedAt: createdAt,
    signature: '',
    version: SOCIAL_MODEL_VERSION,
    revision: 1,
    text,
    contentHash,
    replyTo: input.replyTo,
    mediaAttachments,
    deleted: false,
  };
}

export function createUnsignedPostRevision(input: CanonicalPostRevisionInput): PostData {
  const updatedAt = Math.max(input.updatedAt ?? Date.now(), input.previous.updatedAt + 1);
  const deleted = input.deleted ?? input.previous.deleted;
  const text = deleted ? '' : (input.text ?? input.previous.text).trim();
  const mediaAttachments = deleted
    ? []
    : normalizeAttachments(input.mediaAttachments ?? input.previous.mediaAttachments ?? []);
  const contentHash = hashPostContent({
    author: input.previous.author,
    text,
    replyTo: input.previous.replyTo,
    mediaAttachments,
  });

  return {
    ...input.previous,
    updatedAt,
    signature: '',
    revision: getSocialRevision(input.previous) + 1,
    previousRevisionHash: sha256Hex(getPostSignableBytes(input.previous)),
    text,
    contentHash,
    mediaAttachments,
    deleted,
  };
}

export function createUnsignedProfile(input: CanonicalProfileInput): ProfileData {
  const previous = input.previous ?? null;
  const createdAt = previous?.createdAt ?? input.createdAt ?? Date.now();
  const updatedAt = input.createdAt ?? Date.now();
  return {
    id: `profile_${input.author}`,
    author: input.author,
    createdAt,
    updatedAt: Math.max(updatedAt, previous?.updatedAt ? previous.updatedAt + 1 : updatedAt),
    signature: '',
    version: PROFILE_MODEL_VERSION,
    revision: previous ? getSocialRevision(previous) + 1 : 1,
    previousRevisionHash: previous ? getProfileStateHash(previous) : undefined,
    username: normalizeUsername(input.username || input.displayName || input.author),
    displayName: input.displayName.trim(),
    bio: input.bio?.trim() || undefined,
    avatarHash: input.avatarHash,
    postCount: previous?.postCount ?? 0,
    followerCount: previous?.followerCount ?? 0,
    followingCount: previous?.followingCount ?? 0,
  };
}

export function createUnsignedComment(input: CanonicalCommentInput): CommentData {
  const text = input.text.trim();
  const createdAt = input.createdAt ?? Date.now();
  const contentHash = hashCommentContent({
    author: input.author,
    postId: input.postId,
    text,
    parentCommentId: input.parentCommentId,
  });

  return {
    id: `comment_${contentHash}`,
    author: input.author,
    createdAt,
    updatedAt: createdAt,
    signature: '',
    version: SOCIAL_MODEL_VERSION,
    revision: 1,
    postId: input.postId,
    text,
    contentHash,
    parentCommentId: input.parentCommentId,
    deleted: false,
  };
}

export function createUnsignedReaction(input: CanonicalReactionInput): ReactionData {
  const createdAt = input.createdAt ?? Date.now();
  const reactionType = input.reactionType ?? 'like';
  const target = input.commentId ?? 'post';

  return {
    id: `reaction_${input.author}_${input.postId}_${target}_${reactionType}`,
    author: input.author,
    createdAt,
    updatedAt: createdAt,
    signature: '',
    version: SOCIAL_MODEL_VERSION,
    revision: 1,
    postId: input.postId,
    commentId: input.commentId,
    reactionType,
    deleted: false,
  };
}

export function createUnsignedFollow(input: CanonicalFollowInput): FollowData {
  const previous = input.previous ?? null;
  const createdAt = previous?.createdAt ?? input.createdAt ?? Date.now();
  const updatedAt = input.createdAt ?? Date.now();

  return {
    id: `follow_${input.followerId}_${input.followingId}`,
    author: input.followerId,
    createdAt,
    updatedAt: Math.max(updatedAt, previous?.updatedAt ? previous.updatedAt + 1 : updatedAt),
    signature: '',
    version: SOCIAL_MODEL_VERSION,
    revision: previous ? getSocialRevision(previous) + 1 : 1,
    previousRevisionHash: previous ? sha256Hex(getFollowSignableBytes(previous)) : undefined,
    followerId: input.followerId,
    followingId: input.followingId,
    deleted: input.deleted ?? false,
  };
}

export function createUnsignedChatMessage(input: CanonicalChatMessageInput): ChatMessageData {
  const text = input.text.trim();
  const createdAt = input.createdAt ?? Date.now();
  const contentHash = hashChatMessageContent({
    senderId: input.senderId,
    recipientId: input.recipientId,
    text,
    createdAt,
  });

  return {
    id: `chat_${contentHash}`,
    author: input.senderId,
    createdAt,
    updatedAt: createdAt,
    signature: '',
    version: SOCIAL_MODEL_VERSION,
    revision: 1,
    conversationId: getConversationId(input.senderId, input.recipientId),
    senderId: input.senderId,
    recipientId: input.recipientId,
    text,
    contentHash,
    deleted: false,
  };
}

export function getPostSignableBytes(post: PostData): string {
  return stableStringify({
    id: post.id,
    author: post.author,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    version: post.version,
    ...getSignableRevisionMetadata(post),
    text: post.text,
    contentHash: post.contentHash,
    replyTo: post.replyTo ?? null,
    mediaAttachments: normalizeAttachments(post.mediaAttachments ?? []),
    deleted: post.deleted,
  });
}

export function getProfileSignableBytes(profile: ProfileData): string {
  return stableStringify({
    id: profile.id,
    author: profile.author,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    version: profile.version,
    ...getSignableRevisionMetadata(profile),
    username: profile.username,
    displayName: profile.displayName,
    bio: profile.bio ?? null,
    avatarHash: profile.avatarHash ?? null,
  });
}

export function getLegacyProfileSignableBytes(profile: ProfileData): string {
  return stableStringify({
    id: profile.id,
    author: profile.author,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    version: profile.version,
    ...getSignableRevisionMetadata(profile),
    username: profile.username,
    displayName: profile.displayName,
    bio: profile.bio ?? null,
    avatarHash: profile.avatarHash ?? null,
    postCount: profile.postCount,
    followerCount: profile.followerCount,
    followingCount: profile.followingCount,
  });
}

export function getProfileVerificationBytes(profile: ProfileData): string | null {
  if (profile.version === PROFILE_MODEL_VERSION) {
    return getProfileSignableBytes(profile);
  }
  if (LEGACY_PROFILE_MODEL_VERSIONS.has(profile.version)) {
    return getLegacyProfileSignableBytes(profile);
  }
  return null;
}

export function getProfileVerificationCandidates(profile: ProfileData): string[] {
  const primary = getProfileVerificationBytes(profile);
  if (!primary) {
    return [];
  }
  if (profile.version !== PROFILE_MODEL_VERSION) {
    return [primary];
  }

  const transitional = getLegacyProfileSignableBytes(profile);
  return transitional === primary ? [primary] : [primary, transitional];
}

export function getCommentSignableBytes(comment: CommentData): string {
  return stableStringify({
    id: comment.id,
    author: comment.author,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    version: comment.version,
    ...getSignableRevisionMetadata(comment),
    postId: comment.postId,
    text: comment.text,
    contentHash: comment.contentHash,
    parentCommentId: comment.parentCommentId ?? null,
    deleted: comment.deleted,
  });
}

export function getReactionSignableBytes(reaction: ReactionData): string {
  return stableStringify({
    id: reaction.id,
    author: reaction.author,
    createdAt: reaction.createdAt,
    updatedAt: reaction.updatedAt,
    version: reaction.version,
    ...getSignableRevisionMetadata(reaction),
    postId: reaction.postId,
    commentId: reaction.commentId ?? null,
    reactionType: reaction.reactionType,
    deleted: reaction.deleted,
  });
}

export function getFollowSignableBytes(follow: FollowData): string {
  return stableStringify({
    id: follow.id,
    author: follow.author,
    createdAt: follow.createdAt,
    updatedAt: follow.updatedAt,
    version: follow.version,
    ...getSignableRevisionMetadata(follow),
    followerId: follow.followerId,
    followingId: follow.followingId,
    deleted: follow.deleted,
  });
}

export function getChatMessageSignableBytes(message: ChatMessageData): string {
  return stableStringify({
    id: message.id,
    author: message.author,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    version: message.version,
    ...getSignableRevisionMetadata(message),
    conversationId: message.conversationId,
    senderId: message.senderId,
    recipientId: message.recipientId,
    text: message.text,
    contentHash: message.contentHash,
    deleted: message.deleted,
  });
}

export function getPostStateHash(post: PostData): string {
  return sha256Hex(getPostSignableBytes(post));
}

export function getProfileStateHash(profile: ProfileData): string {
  const signableBytes = getProfileVerificationBytes(profile) ?? getProfileSignableBytes(profile);
  return sha256Hex(signableBytes);
}

export function getCommentStateHash(comment: CommentData): string {
  return sha256Hex(getCommentSignableBytes(comment));
}

export function getReactionStateHash(reaction: ReactionData): string {
  return sha256Hex(getReactionSignableBytes(reaction));
}

export function getFollowStateHash(follow: FollowData): string {
  return sha256Hex(getFollowSignableBytes(follow));
}

export function getChatMessageStateHash(message: ChatMessageData): string {
  return sha256Hex(getChatMessageSignableBytes(message));
}

export function validatePostIntegrity(post: PostData): boolean {
  const model = new Post(post);
  if (!model.validate()) {
    return false;
  }
  return post.id.startsWith('post_') && post.contentHash === hashPostContent(post);
}

export function validateProfileIntegrity(profile: ProfileData): boolean {
  const model = new Profile(profile);
  return model.validate() && profile.id === `profile_${profile.author}`;
}

export function validateCommentIntegrity(comment: CommentData): boolean {
  const model = new Comment(comment);
  return (
    model.validate() &&
    comment.id === `comment_${hashCommentContent(comment)}` &&
    comment.contentHash === hashCommentContent(comment)
  );
}

export function validateReactionIntegrity(reaction: ReactionData): boolean {
  const model = new Reaction(reaction);
  const target = reaction.commentId ?? 'post';
  return (
    model.validate() &&
    reaction.id ===
      `reaction_${reaction.author}_${reaction.postId}_${target}_${reaction.reactionType}`
  );
}

export function validateFollowIntegrity(follow: FollowData): boolean {
  const model = new Follow(follow);
  return (
    model.validate() &&
    follow.id === `follow_${follow.followerId}_${follow.followingId}` &&
    follow.author === follow.followerId
  );
}

export function validateChatMessageIntegrity(message: ChatMessageData): boolean {
  return (
    message.id === `chat_${hashChatMessageContent(message)}` &&
    message.contentHash === hashChatMessageContent(message) &&
    message.author === message.senderId &&
    message.conversationId === getConversationId(message.senderId, message.recipientId) &&
    message.senderId !== message.recipientId &&
    message.text.trim().length > 0 &&
    isValidSocialRevisionMetadata(message)
  );
}

export function getSocialRevision(value: { revision?: number }): number {
  return value.revision ?? 1;
}

export function isValidSocialRevisionMetadata(value: {
  revision?: number;
  previousRevisionHash?: string;
}): boolean {
  if (value.revision === undefined) {
    return value.previousRevisionHash === undefined;
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) {
    return false;
  }
  if (value.revision === 1) {
    return value.previousRevisionHash === undefined;
  }
  return (
    typeof value.previousRevisionHash === 'string' &&
    /^[a-f0-9]{64}$/i.test(value.previousRevisionHash)
  );
}

function getSignableRevisionMetadata(value: {
  revision?: number;
  previousRevisionHash?: string;
}): Record<string, number | string | null> {
  if (value.revision === undefined) {
    return {};
  }
  return {
    revision: value.revision,
    previousRevisionHash: value.previousRevisionHash ?? null,
  };
}

function hashPostContent(input: {
  author: PeerId;
  text: string;
  replyTo?: string;
  mediaAttachments?: PostMediaAttachment[];
}): string {
  return sha256Hex(
    stableStringify({
      author: input.author,
      text: input.text.trim(),
      replyTo: input.replyTo ?? null,
      mediaAttachments: normalizeAttachments(input.mediaAttachments ?? []),
    }),
  );
}

function hashCommentContent(input: {
  author: PeerId;
  postId: string;
  text: string;
  parentCommentId?: string;
}): string {
  return sha256Hex(
    stableStringify({
      author: input.author,
      postId: input.postId,
      text: input.text.trim(),
      parentCommentId: input.parentCommentId ?? null,
    }),
  );
}

function hashChatMessageContent(input: {
  senderId: PeerId;
  recipientId: PeerId;
  text: string;
  createdAt: number;
}): string {
  return sha256Hex(
    stableStringify({
      senderId: input.senderId,
      recipientId: input.recipientId,
      text: input.text.trim(),
      createdAt: input.createdAt,
    }),
  );
}

function normalizeAttachments(attachments: PostMediaAttachment[]): PostMediaAttachment[] {
  return [...attachments]
    .map((attachment) => ({
      id: attachment.id,
      type: attachment.type,
      mime: attachment.mime,
      size: attachment.size,
      hash: attachment.hash,
      chunks: [...attachment.chunks].sort(),
      name: attachment.name,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeUsername(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 30) || 'user'
  );
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}
