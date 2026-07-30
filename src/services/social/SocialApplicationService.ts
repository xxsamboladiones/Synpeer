import { AppError } from '@/errors/AppError';
import type { PrivateMessageCiphertext } from '@/crypto/CryptoTypes';
import { getConversationId, type ChatMessageData } from '@/models/ChatMessage';
import type { CommentData } from '@/models/Comment';
import type { FollowData } from '@/models/Follow';
import type { PostData, PostMediaAttachment } from '@/models/Post';
import type { ProfileData } from '@/models/Profile';
import type { ReactionData, ReactionType } from '@/models/Reaction';
import type { NetworkMessage } from '@/network/NetworkMessage';
import type { PeerId } from '@/network/NetworkTypes';
import type { PeerConnection } from '@/network/PeerTransport';
import { createLogger } from '@/observability/Logger';

import {
  createUnsignedPost,
  createUnsignedPostRevision,
  createUnsignedChatMessage,
  createUnsignedComment,
  createUnsignedFollow,
  createUnsignedProfile,
  createUnsignedReaction,
  getCommentSignableBytes,
  getCommentStateHash,
  getFollowSignableBytes,
  getFollowStateHash,
  getPostSignableBytes,
  getPostStateHash,
  getChatMessageSignableBytes,
  getChatMessageStateHash,
  getProfileVerificationCandidates,
  getProfileSignableBytes,
  getProfileStateHash,
  getReactionSignableBytes,
  getReactionStateHash,
  validateCommentIntegrity,
  validateFollowIntegrity,
  validatePostIntegrity,
  validateChatMessageIntegrity,
  validateProfileIntegrity,
  validateReactionIntegrity,
  PROFILE_MODEL_VERSION,
} from './SocialCanonical';
import {
  resolveSocialConflict,
  type SocialConflictEntity,
  type SocialConflictRecord,
  type SocialConflictResolution,
} from './SocialConflictResolver';
import type { SocialConflictDecisionRepository } from './SocialConflictDecisionRepository';
import { SocialEventBus } from './SocialEventBus';
import {
  createPrivateChatContext,
  createUnsignedChatDeliveryReceipt,
  createUnsignedChatReadReceipt,
  createUnsignedPrivateChatEnvelope,
  getChatDeliveryReceiptSignableBytes,
  getChatReadReceiptSignableBytes,
  getPrivateChatEnvelopeSignableBytes,
  isChatDeliveryReceipt,
  isChatReadReceipt,
  isPrivateChatEnvelope,
  parsePrivateChatMessage,
  type ChatDeliveryReceiptV1,
  type ChatReadReceiptV1,
  type ChatReceiptV1,
  type PrivateChatEnvelopeV1,
} from './PrivateChatProtocol';
import {
  isSocialWirePayload,
  createSocialAckPayload,
  SocialReplicationService,
  type ReplicationResult,
  type SocialWirePayload,
} from './SocialReplicationService';

export interface CreatePostInput {
  text: string;
  replyTo?: string;
  mediaAttachments?: PostMediaAttachment[];
}

export interface CreatePostResult {
  post: PostData;
  persisted: true;
  replication: ReplicationResult;
}

export interface EditPostInput {
  postId: string;
  text: string;
}

export interface EditPostResult {
  post: PostData;
  persisted: true;
  replication: ReplicationResult;
}

export interface DeletePostInput {
  postId: string;
}

export interface DeletePostResult {
  post: PostData;
  persisted: true;
  replication: ReplicationResult;
}

export interface UpdateProfileInput {
  username?: string;
  displayName: string;
  bio?: string;
  avatarHash?: string;
}

export interface UpdateProfileResult {
  profile: ProfileData;
  persisted: true;
  replication: ReplicationResult;
}

export interface CreateCommentInput {
  postId: string;
  text: string;
  parentCommentId?: string;
}

export interface CreateCommentResult {
  comment: CommentData;
  persisted: true;
  replication: ReplicationResult;
}

export interface CreateReactionInput {
  postId: string;
  commentId?: string;
  reactionType?: ReactionType;
}

export interface CreateReactionResult {
  reaction: ReactionData;
  persisted: true;
  replication: ReplicationResult;
}

export interface CreateFollowInput {
  followingId: PeerId;
}

export interface CreateFollowResult {
  follow: FollowData;
  persisted: true;
  replication: ReplicationResult;
}

export interface CreateChatMessageInput {
  recipientId: PeerId;
  text: string;
}

export interface CreateChatMessageResult {
  message: ChatMessageData;
  persisted: true;
  replication: ReplicationResult;
}

export interface CreateUnfollowInput {
  followingId: PeerId;
}

export interface CreateUnfollowResult {
  follow: FollowData;
  persisted: true;
  replication: ReplicationResult;
}

export interface RemoteApplyResult {
  applied: boolean;
  skipped: boolean;
  conflict: boolean;
}

export interface SocialCryptoProvider {
  loadIdentity(): string | null;
  sign(data: string): Promise<string>;
  verify(data: string, signature: string, publicIdentity: string): Promise<boolean>;
  encryptForPeer(
    peerPublicIdentity: string,
    plaintext: string,
    context: string,
  ): Promise<PrivateMessageCiphertext>;
  decryptFromPeer(
    peerPublicIdentity: string,
    encrypted: PrivateMessageCiphertext,
    context: string,
  ): Promise<string>;
}

export interface SocialPostStore {
  create(post: PostData): Promise<void>;
  update(post: PostData): Promise<void>;
  getById(id: string): Promise<PostData | null>;
  getByContentHash(contentHash: string): Promise<PostData[]>;
}

export interface SocialProfileStore {
  create(profile: ProfileData): Promise<void>;
  update(profile: ProfileData): Promise<void>;
  getByAuthor(author: string): Promise<ProfileData | null>;
}

export interface SocialCommentStore {
  create(comment: CommentData): Promise<void>;
  update(comment: CommentData): Promise<void>;
  getById(id: string): Promise<CommentData | null>;
  getByContentHash(contentHash: string): Promise<CommentData[]>;
}

export interface SocialReactionStore {
  create(reaction: ReactionData): Promise<void>;
  update(reaction: ReactionData): Promise<void>;
  getById(id: string): Promise<ReactionData | null>;
}

export interface SocialFollowStore {
  create(follow: FollowData): Promise<void>;
  update(follow: FollowData): Promise<void>;
  getById(id: string): Promise<FollowData | null>;
  getByPeers(followerId: string, followingId: string): Promise<FollowData | null>;
}

export interface SocialChatMessageStore {
  create(message: ChatMessageData): Promise<void>;
  update(message: ChatMessageData): Promise<void>;
  getById(id: string): Promise<ChatMessageData | null>;
  getByContentHash(contentHash: string): Promise<ChatMessageData[]>;
  getConversation(
    conversationId: string,
    limit?: number,
    offset?: number,
  ): Promise<ChatMessageData[]>;
}

export interface SocialMediaSync {
  ensurePostMediaAvailable(post: PostData, sourcePeerId: PeerId): Promise<unknown>;
}

export class SocialApplicationService {
  readonly events = new SocialEventBus();
  private readonly logger = createLogger('SocialApplicationService');

  constructor(
    private readonly posts: SocialPostStore,
    private readonly profiles: SocialProfileStore,
    private readonly crypto: SocialCryptoProvider,
    private readonly replication: SocialReplicationService,
    private readonly comments?: SocialCommentStore,
    private readonly reactions?: SocialReactionStore,
    private readonly follows?: SocialFollowStore,
    private readonly mediaSync?: SocialMediaSync,
    private readonly chatMessages?: SocialChatMessageStore,
    private readonly conflictDecisions?: SocialConflictDecisionRepository,
  ) {}

  async createPost(input: CreatePostInput): Promise<CreatePostResult> {
    const author = this.requireLocalIdentity();
    const post = createUnsignedPost({
      author,
      text: input.text,
      replyTo: input.replyTo,
      mediaAttachments: input.mediaAttachments,
    });

    if (!validatePostIntegrity({ ...post, signature: 'pending' })) {
      throw socialError('SOCIAL_POST_INVALID', 'Post content is invalid');
    }

    const existingByHash = await this.posts.getByContentHash(post.contentHash);
    const existing = existingByHash.find((item) => item.author === author && item.id === post.id);
    const signedPost = existing ?? {
      ...post,
      signature: await this.crypto.sign(getPostSignableBytes(post)),
    };

    if (!existing) {
      await this.posts.create(signedPost);
      this.events.emit({
        type: 'social.post.persisted',
        postId: signedPost.id,
        origin: 'local',
        timestamp: Date.now(),
      });
      this.events.emit({
        type: 'social.post.created',
        postId: signedPost.id,
        author,
        origin: 'local',
        timestamp: Date.now(),
      });
    }

    const replication = await this.replication.replicatePost(signedPost);
    this.events.emit({
      type: 'social.post.replication.completed',
      postId: signedPost.id,
      successfulPeers: replication.successfulPeers,
      failedPeers: replication.failedPeers.map((peer) => peer.peerId),
      timestamp: Date.now(),
    });

    return {
      post: signedPost,
      persisted: true,
      replication,
    };
  }

  async editPost(input: EditPostInput): Promise<EditPostResult> {
    const author = this.requireLocalIdentity();
    const existing = await this.posts.getById(input.postId);
    if (!existing || existing.deleted) {
      throw socialError('SOCIAL_POST_NOT_FOUND', 'Post was not found');
    }
    if (existing.author !== author) {
      throw socialError('SOCIAL_POST_FORBIDDEN', 'Only the post author can edit this post');
    }
    const post = createUnsignedPostRevision({
      previous: existing,
      text: input.text,
      deleted: false,
    });
    if (!validatePostIntegrity({ ...post, signature: 'pending' })) {
      throw socialError('SOCIAL_POST_INVALID', 'Post content is invalid');
    }
    const signedPost = {
      ...post,
      signature: await this.crypto.sign(getPostSignableBytes(post)),
    };
    await this.posts.update(signedPost);
    this.events.emit({
      type: 'social.post.persisted',
      postId: signedPost.id,
      origin: 'local',
      timestamp: Date.now(),
    });
    this.events.emit({
      type: 'social.post.updated',
      postId: signedPost.id,
      author,
      origin: 'local',
      timestamp: Date.now(),
    });
    const replication = await this.replication.replicatePost(signedPost);
    return {
      post: signedPost,
      persisted: true,
      replication,
    };
  }

  async deletePost(input: DeletePostInput): Promise<DeletePostResult> {
    const author = this.requireLocalIdentity();
    const existing = await this.posts.getById(input.postId);
    if (!existing || existing.deleted) {
      throw socialError('SOCIAL_POST_NOT_FOUND', 'Post was not found');
    }
    if (existing.author !== author) {
      throw socialError('SOCIAL_POST_FORBIDDEN', 'Only the post author can delete this post');
    }
    const post = createUnsignedPostRevision({
      previous: existing,
      deleted: true,
    });
    if (!validatePostIntegrity({ ...post, signature: 'pending' })) {
      throw socialError('SOCIAL_POST_INVALID', 'Post content is invalid');
    }
    const signedPost = {
      ...post,
      signature: await this.crypto.sign(getPostSignableBytes(post)),
    };
    await this.posts.update(signedPost);
    this.events.emit({
      type: 'social.post.persisted',
      postId: signedPost.id,
      origin: 'local',
      timestamp: Date.now(),
    });
    this.events.emit({
      type: 'social.post.deleted',
      postId: signedPost.id,
      author,
      origin: 'local',
      timestamp: Date.now(),
    });
    const replication = await this.replication.replicatePost(signedPost);
    return {
      post: signedPost,
      persisted: true,
      replication,
    };
  }

  async updateLocalProfile(input: UpdateProfileInput): Promise<UpdateProfileResult> {
    const author = this.requireLocalIdentity();
    const previous = await this.profiles.getByAuthor(author);
    const profile = createUnsignedProfile({
      author,
      username: input.username ?? input.displayName,
      displayName: input.displayName,
      bio: input.bio,
      avatarHash: input.avatarHash,
      previous,
    });

    if (!validateProfileIntegrity({ ...profile, signature: 'pending' })) {
      throw socialError('SOCIAL_PROFILE_INVALID', 'Profile content is invalid');
    }

    const signedProfile = {
      ...profile,
      signature: await this.crypto.sign(getProfileSignableBytes(profile)),
    };
    if (previous) {
      await this.profiles.update(signedProfile);
    } else {
      await this.profiles.create(signedProfile);
    }

    this.events.emit({
      type: 'social.profile.updated',
      profileId: signedProfile.id,
      author,
      origin: 'local',
      timestamp: Date.now(),
    });
    const replication = await this.replication.replicateProfile(signedProfile);
    return {
      profile: signedProfile,
      persisted: true,
      replication,
    };
  }

  async migrateLocalProfileSignature(): Promise<ProfileData | null> {
    const identity = this.crypto.loadIdentity();
    if (!identity) {
      return null;
    }
    const author = identity as PeerId;
    const previous = await this.profiles.getByAuthor(author);
    if (!previous) {
      return null;
    }
    if (!validateProfileIntegrity(previous)) {
      this.logger.warn('local_profile_migration_skipped', {
        profileId: previous.id,
        previousVersion: previous.version,
        reason: 'invalid-profile',
      });
      return null;
    }

    const verificationCandidates = getProfileVerificationCandidates(previous);
    if (verificationCandidates.length === 0) {
      this.logger.warn('local_profile_migration_skipped', {
        profileId: previous.id,
        previousVersion: previous.version,
        reason: 'unsupported-version',
      });
      return null;
    }
    const currentSignatureValid =
      previous.version === PROFILE_MODEL_VERSION &&
      (await this.crypto.verify(
        getProfileSignableBytes(previous),
        previous.signature,
        previous.author,
      ));
    if (currentSignatureValid) {
      return null;
    }
    const previousSignatureValid = await this.verifyProfileSignature(
      previous,
      verificationCandidates,
    );
    const migrated = createUnsignedProfile({
      author,
      username: previous.username,
      displayName: previous.displayName,
      bio: previous.bio,
      avatarHash: previous.avatarHash,
      previous,
    });
    const signedProfile = {
      ...migrated,
      signature: await this.crypto.sign(getProfileSignableBytes(migrated)),
    };
    await this.profiles.update(signedProfile);
    this.logger.info('local_profile_signature_migrated', {
      profileId: signedProfile.id,
      previousVersion: previous.version,
      version: signedProfile.version,
      previousSignatureValid,
    });
    return signedProfile;
  }

  async createComment(input: CreateCommentInput): Promise<CreateCommentResult> {
    if (!this.comments) {
      throw socialError('SOCIAL_COMMENT_STORE_UNAVAILABLE', 'Comment store is not available');
    }
    const author = this.requireLocalIdentity();
    const comment = createUnsignedComment({
      author,
      postId: input.postId,
      text: input.text,
      parentCommentId: input.parentCommentId,
    });
    if (!validateCommentIntegrity({ ...comment, signature: 'pending' })) {
      throw socialError('SOCIAL_COMMENT_INVALID', 'Comment content is invalid');
    }

    const existingByHash = await this.comments.getByContentHash(comment.contentHash);
    const existing = existingByHash.find(
      (item) => item.author === author && item.id === comment.id,
    );
    const signedComment = existing ?? {
      ...comment,
      signature: await this.crypto.sign(getCommentSignableBytes(comment)),
    };
    if (!existing) {
      await this.comments.create(signedComment);
      this.events.emit({
        type: 'social.comment.persisted',
        commentId: signedComment.id,
        postId: signedComment.postId,
        origin: 'local',
        timestamp: Date.now(),
      });
    }

    return {
      comment: signedComment,
      persisted: true,
      replication: await this.replication.replicateComment(signedComment),
    };
  }

  async createReaction(input: CreateReactionInput): Promise<CreateReactionResult> {
    if (!this.reactions) {
      throw socialError('SOCIAL_REACTION_STORE_UNAVAILABLE', 'Reaction store is not available');
    }
    const author = this.requireLocalIdentity();
    const reaction = createUnsignedReaction({
      author,
      postId: input.postId,
      commentId: input.commentId,
      reactionType: input.reactionType,
    });
    if (!validateReactionIntegrity({ ...reaction, signature: 'pending' })) {
      throw socialError('SOCIAL_REACTION_INVALID', 'Reaction content is invalid');
    }

    const existing = await this.reactions.getById(reaction.id);
    const signedReaction = existing ?? {
      ...reaction,
      signature: await this.crypto.sign(getReactionSignableBytes(reaction)),
    };
    if (!existing) {
      await this.reactions.create(signedReaction);
      this.events.emit({
        type: 'social.reaction.persisted',
        reactionId: signedReaction.id,
        postId: signedReaction.postId,
        origin: 'local',
        timestamp: Date.now(),
      });
    }

    return {
      reaction: signedReaction,
      persisted: true,
      replication: await this.replication.replicateReaction(signedReaction),
    };
  }

  async createFollow(input: CreateFollowInput): Promise<CreateFollowResult> {
    if (!this.follows) {
      throw socialError('SOCIAL_FOLLOW_STORE_UNAVAILABLE', 'Follow store is not available');
    }
    const followerId = this.requireLocalIdentity();
    const previous =
      (await this.follows.getById(getFollowId(followerId, input.followingId))) ??
      (await this.follows.getByPeers(followerId, input.followingId));
    const follow = createUnsignedFollow({
      followerId,
      followingId: input.followingId,
      previous,
    });
    if (!validateFollowIntegrity({ ...follow, signature: 'pending' })) {
      throw socialError('SOCIAL_FOLLOW_INVALID', 'Follow content is invalid');
    }

    const signedFollow = {
      ...follow,
      signature: await this.crypto.sign(getFollowSignableBytes(follow)),
    };
    if (previous) {
      await this.follows.update(signedFollow);
    } else {
      await this.follows.create(signedFollow);
    }
    this.events.emit({
      type: 'social.follow.persisted',
      followId: signedFollow.id,
      followerId: signedFollow.followerId,
      followingId: signedFollow.followingId,
      deleted: signedFollow.deleted,
      origin: 'local',
      timestamp: Date.now(),
    });

    return {
      follow: signedFollow,
      persisted: true,
      replication: await this.replication.replicateFollow(signedFollow),
    };
  }

  async createUnfollow(input: CreateUnfollowInput): Promise<CreateUnfollowResult> {
    if (!this.follows) {
      throw socialError('SOCIAL_FOLLOW_STORE_UNAVAILABLE', 'Follow store is not available');
    }
    const followerId = this.requireLocalIdentity();
    const previous =
      (await this.follows.getById(getFollowId(followerId, input.followingId))) ??
      (await this.follows.getByPeers(followerId, input.followingId));
    const follow = createUnsignedFollow({
      followerId,
      followingId: input.followingId,
      previous,
      deleted: true,
    });
    if (!validateFollowIntegrity({ ...follow, signature: 'pending' })) {
      throw socialError('SOCIAL_FOLLOW_INVALID', 'Unfollow content is invalid');
    }

    const signedFollow = {
      ...follow,
      signature: await this.crypto.sign(getFollowSignableBytes(follow)),
    };
    if (previous) {
      await this.follows.update(signedFollow);
    } else {
      await this.follows.create(signedFollow);
    }
    this.events.emit({
      type: 'social.follow.persisted',
      followId: signedFollow.id,
      followerId: signedFollow.followerId,
      followingId: signedFollow.followingId,
      deleted: signedFollow.deleted,
      origin: 'local',
      timestamp: Date.now(),
    });

    return {
      follow: signedFollow,
      persisted: true,
      replication: await this.replication.replicateFollow(signedFollow),
    };
  }

  async createChatMessage(input: CreateChatMessageInput): Promise<CreateChatMessageResult> {
    if (!this.chatMessages) {
      throw socialError('SOCIAL_CHAT_STORE_UNAVAILABLE', 'Chat message store is not available');
    }
    const senderId = this.requireLocalIdentity();
    const text = input.text.trim();
    if (text.length === 0 || text.length > 4000) {
      throw socialError('SOCIAL_CHAT_INVALID', 'Chat message text is invalid');
    }
    await this.requireChatRelationship(senderId, input.recipientId);

    const message = createUnsignedChatMessage({
      senderId,
      recipientId: input.recipientId,
      text,
    });
    if (!validateChatMessageIntegrity({ ...message, signature: 'pending' })) {
      throw socialError('SOCIAL_CHAT_INVALID', 'Chat message content is invalid');
    }

    const existingByHash = await this.chatMessages.getByContentHash(message.contentHash);
    const existing = existingByHash.find(
      (item) => item.senderId === senderId && item.recipientId === input.recipientId,
    );
    const signedMessage = existing ?? {
      ...message,
      signature: await this.crypto.sign(getChatMessageSignableBytes(message)),
    };

    if (!existing) {
      await this.chatMessages.create(signedMessage);
      this.events.emit({
        type: 'social.chat.persisted',
        messageId: signedMessage.id,
        conversationId: signedMessage.conversationId,
        origin: 'local',
        timestamp: Date.now(),
      });
    }

    const context = createPrivateChatContext({
      messageId: signedMessage.id,
      senderId: signedMessage.senderId,
      recipientId: signedMessage.recipientId,
    });
    const encrypted = await this.crypto.encryptForPeer(
      signedMessage.recipientId,
      JSON.stringify(signedMessage),
      context,
    );
    const unsignedEnvelope = createUnsignedPrivateChatEnvelope({
      message: signedMessage,
      encrypted,
    });
    const envelope: PrivateChatEnvelopeV1 = {
      ...unsignedEnvelope,
      signature: await this.crypto.sign(getPrivateChatEnvelopeSignableBytes(unsignedEnvelope)),
    };

    return {
      message: signedMessage,
      persisted: true,
      replication: await this.replication.replicatePrivateChatEnvelope(envelope),
    };
  }

  async handleRemoteMessage(
    message: NetworkMessage,
    connection: PeerConnection,
  ): Promise<RemoteApplyResult | null> {
    if (
      message.messageType !== 'social.post' &&
      message.messageType !== 'social.profile' &&
      message.messageType !== 'social.comment' &&
      message.messageType !== 'social.reaction' &&
      message.messageType !== 'social.follow' &&
      message.messageType !== 'social.chat' &&
      message.messageType !== 'social.chat.receipt'
    ) {
      return null;
    }
    if (!isSocialWirePayload(message.payload)) {
      throw socialError('SOCIAL_POST_INVALID', 'Invalid social wire payload');
    }

    const payload = message.payload;
    const deliveryId = message.correlationId ?? message.messageId;
    const claim = await this.replication.claimIncoming(message, payload, connection.peerId);
    if (claim && !claim.accepted) {
      const duplicateResult: RemoteApplyResult = {
        applied: false,
        skipped: true,
        conflict: false,
      };
      await this.sendAck(payload, connection, message.correlationId, duplicateResult);
      return duplicateResult;
    }

    try {
      const result = await this.dispatchRemoteMessage(message, payload, connection);
      await this.replication.markIncomingApplied(deliveryId);
      return result;
    } catch (error) {
      if (!(error instanceof AppError) || !error.retryable) {
        await this.replication.markIncomingRejected(
          deliveryId,
          error instanceof AppError ? error.code : 'VALIDATION_ERROR',
        );
      }
      throw error;
    }
  }

  async markConversationRead(peerId: PeerId, readAt = Date.now()): Promise<number> {
    if (!this.chatMessages) {
      return 0;
    }
    const localPeerId = this.requireLocalIdentity();
    const conversationId = getConversationId(localPeerId, peerId);
    const messages = await this.chatMessages.getConversation(conversationId, 1000, 0);
    const unreadMessages = messages.filter(
      (message) =>
        message.recipientId === localPeerId &&
        message.senderId === peerId &&
        message.readAt === undefined,
    );

    for (const message of unreadMessages) {
      const messageReadAt = Math.max(readAt, message.createdAt);
      await this.chatMessages.update({
        ...message,
        readAt: messageReadAt,
      });
      const unsignedReceipt = createUnsignedChatReadReceipt({
        messageId: message.id,
        senderId: message.senderId,
        recipientId: message.recipientId,
        readAt: messageReadAt,
      });
      const receipt: ChatReadReceiptV1 = {
        ...unsignedReceipt,
        signature: await this.crypto.sign(getChatReadReceiptSignableBytes(unsignedReceipt)),
      };
      await this.replication.replicateChatReadReceipt(receipt);
      this.events.emit({
        type: 'social.chat.read.updated',
        messageId: message.id,
        conversationId,
        readAt: messageReadAt,
        peerId,
        timestamp: Date.now(),
      });
    }
    return unreadMessages.length;
  }

  async restoreChatReceiptProjections(): Promise<number> {
    if (!this.chatMessages) {
      return 0;
    }
    const localPeerId = this.crypto.loadIdentity();
    if (!localPeerId) {
      return 0;
    }
    let restored = 0;
    for (const receipt of await this.replication.listChatReceipts()) {
      if (receipt.senderId !== localPeerId) {
        continue;
      }
      const message = await this.chatMessages.getById(receipt.messageId);
      if (!message || !receiptMatchesMessage(receipt, message)) {
        continue;
      }
      if (receipt.type === 'chat.delivery.receipt' && message.deliveredAt === undefined) {
        await this.chatMessages.update({ ...message, deliveredAt: receipt.deliveredAt });
        restored += 1;
      }
      if (receipt.type === 'chat.read.receipt' && message.readAt === undefined) {
        await this.chatMessages.update({
          ...message,
          deliveredAt: message.deliveredAt ?? receipt.readAt,
          readAt: receipt.readAt,
        });
        restored += 1;
      }
    }
    return restored;
  }

  private async dispatchRemoteMessage(
    message: NetworkMessage,
    payload: SocialWirePayload,
    connection: PeerConnection,
  ): Promise<RemoteApplyResult> {
    if (payload.entity === 'post') {
      return await this.applyAndGossip(
        payload,
        connection,
        message.correlationId,
        await this.applyRemotePost(payload.post, connection.peerId),
      );
    }
    if (payload.entity === 'profile') {
      return await this.applyAndGossip(
        payload,
        connection,
        message.correlationId,
        await this.applyRemoteProfile(payload.profile, connection.peerId),
      );
    }
    if (payload.entity === 'comment') {
      return await this.applyAndGossip(
        payload,
        connection,
        message.correlationId,
        await this.applyRemoteComment(payload.comment, connection.peerId),
      );
    }
    if (payload.entity === 'reaction') {
      return await this.applyAndGossip(
        payload,
        connection,
        message.correlationId,
        await this.applyRemoteReaction(payload.reaction, connection.peerId),
      );
    }
    if (payload.entity === 'chat') {
      if ('envelope' in payload) {
        return await this.handlePrivateChatEnvelope(payload, connection, message.correlationId);
      }
      const legacyResult = await this.applyRemoteChatMessage(payload.chat, connection.peerId);
      await this.sendAck(payload, connection, message.correlationId, legacyResult);
      return legacyResult;
    }
    if (payload.entity === 'chat-receipt') {
      return await this.handleChatReceipt(payload, connection, message.correlationId);
    }
    return await this.applyAndGossip(
      payload,
      connection,
      message.correlationId,
      await this.applyRemoteFollow(payload.follow, connection.peerId),
    );
  }

  async applyRemotePost(post: PostData, peerId: string): Promise<RemoteApplyResult> {
    if (!validatePostIntegrity(post)) {
      this.logger.warn('remote_post_integrity_rejected', {
        peerId,
        postId: typeof post.id === 'string' ? post.id : 'unknown',
        author: typeof post.author === 'string' ? post.author : 'unknown',
        version: typeof post.version === 'string' ? post.version : 'unknown',
      });
      return { applied: false, skipped: true, conflict: false };
    }
    if (!(await this.crypto.verify(getPostSignableBytes(post), post.signature, post.author))) {
      throw socialError('SOCIAL_POST_INVALID', 'Remote post signature is invalid');
    }

    const existing = await this.posts.getById(post.id);
    const conflictResult = await this.resolveRemoteRecord({
      entity: 'post',
      existing,
      incoming: post,
      existingStateHash: existing ? getPostStateHash(existing) : undefined,
      incomingStateHash: getPostStateHash(post),
      peerId,
    });
    if (conflictResult) {
      return conflictResult;
    }
    if (existing) {
      await this.posts.update(post);
      this.events.emit({
        type: 'social.post.persisted',
        postId: post.id,
        origin: 'remote',
        timestamp: Date.now(),
      });
      this.events.emit({
        type: post.deleted ? 'social.post.deleted' : 'social.post.updated',
        postId: post.id,
        author: post.author,
        origin: 'remote',
        peerId,
        timestamp: Date.now(),
      });
      if (!post.deleted) {
        await this.mediaSync?.ensurePostMediaAvailable(post, peerId as PeerId);
      }
      return { applied: true, skipped: false, conflict: false };
    }

    const duplicates = await this.posts.getByContentHash(post.contentHash);
    if (duplicates.some((item) => item.author === post.author)) {
      return { applied: false, skipped: true, conflict: false };
    }

    await this.posts.create(post);
    this.events.emit({
      type: 'social.post.persisted',
      postId: post.id,
      origin: 'remote',
      timestamp: Date.now(),
    });
    this.events.emit({
      type: 'social.post.received',
      postId: post.id,
      author: post.author,
      peerId,
      timestamp: Date.now(),
    });
    await this.mediaSync?.ensurePostMediaAvailable(post, peerId as PeerId);
    return { applied: true, skipped: false, conflict: false };
  }

  async applyRemoteProfile(profile: ProfileData, peerId: string): Promise<RemoteApplyResult> {
    if (!validateProfileIntegrity(profile)) {
      throw socialError('SOCIAL_PROFILE_INVALID', 'Remote profile failed integrity validation');
    }
    const verificationCandidates = getProfileVerificationCandidates(profile);
    if (!(await this.verifyProfileSignature(profile, verificationCandidates))) {
      throw socialError('SOCIAL_PROFILE_INVALID', 'Remote profile signature is invalid');
    }

    const existing = await this.profiles.getByAuthor(profile.author);
    const conflictResult = await this.resolveRemoteRecord({
      entity: 'profile',
      existing,
      incoming: profile,
      existingStateHash: existing ? getProfileStateHash(existing) : undefined,
      incomingStateHash: getProfileStateHash(profile),
      peerId,
    });
    if (conflictResult) {
      return conflictResult;
    }
    const persistedProfile =
      profile.version === PROFILE_MODEL_VERSION
        ? {
            ...profile,
            postCount: existing?.postCount ?? 0,
            followerCount: existing?.followerCount ?? 0,
            followingCount: existing?.followingCount ?? 0,
          }
        : profile;
    if (existing) {
      await this.profiles.update(persistedProfile);
    } else {
      await this.profiles.create(persistedProfile);
    }
    this.events.emit({
      type: 'social.profile.updated',
      profileId: profile.id,
      author: profile.author,
      origin: 'remote',
      timestamp: Date.now(),
    });
    return { applied: true, skipped: false, conflict: false };
  }

  async applyRemoteComment(comment: CommentData, peerId: string): Promise<RemoteApplyResult> {
    if (!this.comments) {
      return { applied: false, skipped: true, conflict: false };
    }
    if (!validateCommentIntegrity(comment)) {
      throw socialError('SOCIAL_COMMENT_INVALID', 'Remote comment failed integrity validation');
    }
    if (
      !(await this.crypto.verify(
        getCommentSignableBytes(comment),
        comment.signature,
        comment.author,
      ))
    ) {
      throw socialError('SOCIAL_COMMENT_INVALID', 'Remote comment signature is invalid');
    }

    const existing = await this.comments.getById(comment.id);
    const conflictResult = await this.resolveRemoteRecord({
      entity: 'comment',
      existing,
      incoming: comment,
      existingStateHash: existing ? getCommentStateHash(existing) : undefined,
      incomingStateHash: getCommentStateHash(comment),
      peerId,
    });
    if (conflictResult) {
      return conflictResult;
    }

    if (existing) {
      await this.comments.update(comment);
    } else {
      const duplicates = await this.comments.getByContentHash(comment.contentHash);
      if (duplicates.some((item) => item.author === comment.author)) {
        return { applied: false, skipped: true, conflict: false };
      }
      await this.comments.create(comment);
    }
    this.events.emit({
      type: 'social.comment.persisted',
      commentId: comment.id,
      postId: comment.postId,
      origin: 'remote',
      peerId,
      timestamp: Date.now(),
    });
    return { applied: true, skipped: false, conflict: false };
  }

  async applyRemoteReaction(reaction: ReactionData, peerId: string): Promise<RemoteApplyResult> {
    if (!this.reactions) {
      return { applied: false, skipped: true, conflict: false };
    }
    if (!validateReactionIntegrity(reaction)) {
      throw socialError('SOCIAL_REACTION_INVALID', 'Remote reaction failed integrity validation');
    }
    if (
      !(await this.crypto.verify(
        getReactionSignableBytes(reaction),
        reaction.signature,
        reaction.author,
      ))
    ) {
      throw socialError('SOCIAL_REACTION_INVALID', 'Remote reaction signature is invalid');
    }

    const existing = await this.reactions.getById(reaction.id);
    const conflictResult = await this.resolveRemoteRecord({
      entity: 'reaction',
      existing,
      incoming: reaction,
      existingStateHash: existing ? getReactionStateHash(existing) : undefined,
      incomingStateHash: getReactionStateHash(reaction),
      peerId,
    });
    if (conflictResult) {
      return conflictResult;
    }
    if (existing) {
      await this.reactions.update(reaction);
    } else {
      await this.reactions.create(reaction);
    }
    this.events.emit({
      type: 'social.reaction.persisted',
      reactionId: reaction.id,
      postId: reaction.postId,
      origin: 'remote',
      peerId,
      timestamp: Date.now(),
    });
    return { applied: true, skipped: false, conflict: false };
  }

  async applyRemoteFollow(follow: FollowData, peerId: string): Promise<RemoteApplyResult> {
    if (!this.follows) {
      return { applied: false, skipped: true, conflict: false };
    }
    if (!validateFollowIntegrity(follow)) {
      throw socialError('SOCIAL_FOLLOW_INVALID', 'Remote follow failed integrity validation');
    }
    if (
      !(await this.crypto.verify(getFollowSignableBytes(follow), follow.signature, follow.author))
    ) {
      throw socialError('SOCIAL_FOLLOW_INVALID', 'Remote follow signature is invalid');
    }

    const existing = await this.follows.getById(follow.id);
    const conflictResult = await this.resolveRemoteRecord({
      entity: 'follow',
      existing,
      incoming: follow,
      existingStateHash: existing ? getFollowStateHash(existing) : undefined,
      incomingStateHash: getFollowStateHash(follow),
      peerId,
    });
    if (conflictResult) {
      return conflictResult;
    }
    if (existing) {
      await this.follows.update(follow);
    } else {
      await this.follows.create(follow);
    }
    this.events.emit({
      type: 'social.follow.persisted',
      followId: follow.id,
      followerId: follow.followerId,
      followingId: follow.followingId,
      deleted: follow.deleted,
      origin: 'remote',
      peerId,
      timestamp: Date.now(),
    });
    return { applied: true, skipped: false, conflict: false };
  }

  async applyRemoteChatMessage(
    message: ChatMessageData,
    peerId: string,
  ): Promise<RemoteApplyResult> {
    if (!this.chatMessages) {
      return { applied: false, skipped: true, conflict: false };
    }
    if (!validateChatMessageIntegrity(message)) {
      throw socialError('SOCIAL_CHAT_INVALID', 'Remote chat message failed integrity validation');
    }
    if (
      !(await this.crypto.verify(
        getChatMessageSignableBytes(message),
        message.signature,
        message.senderId,
      ))
    ) {
      throw socialError('SOCIAL_CHAT_INVALID', 'Remote chat message signature is invalid');
    }

    const localPeerId = this.crypto.loadIdentity();
    if (localPeerId !== message.senderId && localPeerId !== message.recipientId) {
      return { applied: false, skipped: true, conflict: false };
    }

    const existing = await this.chatMessages.getById(message.id);
    const conflictResult = await this.resolveRemoteRecord({
      entity: 'chat',
      existing,
      incoming: message,
      existingStateHash: existing ? getChatMessageStateHash(existing) : undefined,
      incomingStateHash: getChatMessageStateHash(message),
      peerId,
    });
    if (conflictResult) {
      return conflictResult;
    }

    if (!existing) {
      const duplicates = await this.chatMessages.getByContentHash(message.contentHash);
      if (
        duplicates.some(
          (item) => item.senderId === message.senderId && item.recipientId === message.recipientId,
        )
      ) {
        return { applied: false, skipped: true, conflict: false };
      }
    }

    const deliveredMessage =
      localPeerId === message.recipientId
        ? { ...message, relayOnly: false, deliveredAt: Date.now() }
        : { ...message, relayOnly: false };
    if (existing) {
      await this.chatMessages.update(deliveredMessage);
    } else {
      await this.chatMessages.create(deliveredMessage);
    }
    this.events.emit({
      type: 'social.chat.persisted',
      messageId: deliveredMessage.id,
      conversationId: deliveredMessage.conversationId,
      origin: 'remote',
      peerId,
      timestamp: Date.now(),
    });
    return { applied: true, skipped: false, conflict: false };
  }

  private async handlePrivateChatEnvelope(
    payload: Extract<SocialWirePayload, { entity: 'chat'; envelope: PrivateChatEnvelopeV1 }>,
    connection: PeerConnection,
    correlationId: string | undefined,
  ): Promise<RemoteApplyResult> {
    const outcome = await this.applyPrivateChatEnvelope(payload.envelope, connection.peerId);
    let hasDurableCustody = false;
    let deliveryReceipt: ChatDeliveryReceiptV1 | null = null;
    if (outcome.deliveredMessage && !outcome.result.conflict) {
      deliveryReceipt = await this.createChatDeliveryReceipt(outcome.deliveredMessage);
      hasDurableCustody = await this.replication.acquireChatDeliveryReceiptCustody(deliveryReceipt);
    } else if (outcome.result.applied) {
      hasDurableCustody = await this.replication.acquireRelayCustody(payload, connection.peerId);
    }

    if (outcome.result.applied && !hasDurableCustody) {
      if (deliveryReceipt) {
        await this.replication.replicateChatDeliveryReceipt(deliveryReceipt);
      } else {
        await this.replication.gossipRemotePayload(payload, connection.peerId);
      }
    }

    await this.sendAck(payload, connection, correlationId, outcome.result);
    if (hasDurableCustody) {
      await this.replication.processPendingQueue();
    }
    return outcome.result;
  }

  private async applyPrivateChatEnvelope(
    envelope: PrivateChatEnvelopeV1,
    peerId: PeerId,
  ): Promise<{ result: RemoteApplyResult; deliveredMessage?: ChatMessageData }> {
    if (!isPrivateChatEnvelope(envelope)) {
      throw socialError('SOCIAL_CHAT_INVALID', 'Private chat envelope is invalid');
    }
    if (
      !(await this.crypto.verify(
        getPrivateChatEnvelopeSignableBytes(envelope),
        envelope.signature,
        envelope.senderId,
      ))
    ) {
      throw socialError('SOCIAL_CHAT_INVALID', 'Private chat envelope signature is invalid');
    }

    const localPeerId = this.crypto.loadIdentity();
    if (localPeerId !== envelope.recipientId) {
      return {
        result: { applied: true, skipped: false, conflict: false },
      };
    }

    const context = createPrivateChatContext(envelope);
    const serialized = await this.crypto.decryptFromPeer(
      envelope.senderId,
      {
        version: envelope.version,
        algorithm: envelope.algorithm,
        ciphertext: envelope.ciphertext,
        nonce: envelope.nonce,
      },
      context,
    );
    const decrypted = parsePrivateChatMessage(serialized);
    if (
      !decrypted ||
      decrypted.id !== envelope.messageId ||
      decrypted.senderId !== envelope.senderId ||
      decrypted.recipientId !== envelope.recipientId ||
      decrypted.createdAt !== envelope.createdAt
    ) {
      throw socialError('SOCIAL_CHAT_INVALID', 'Private chat payload does not match its envelope');
    }

    const result = await this.applyRemoteChatMessage(decrypted, peerId);
    const deliveredMessage = this.chatMessages
      ? await this.chatMessages.getById(decrypted.id)
      : null;
    return {
      result,
      deliveredMessage: deliveredMessage ?? undefined,
    };
  }

  private async createChatDeliveryReceipt(
    message: ChatMessageData,
  ): Promise<ChatDeliveryReceiptV1> {
    const deliveredAt = message.deliveredAt ?? Date.now();
    const unsignedReceipt = createUnsignedChatDeliveryReceipt({
      messageId: message.id,
      senderId: message.senderId,
      recipientId: message.recipientId,
      deliveredAt,
    });
    return {
      ...unsignedReceipt,
      signature: await this.crypto.sign(getChatDeliveryReceiptSignableBytes(unsignedReceipt)),
    };
  }

  private async handleChatReceipt(
    payload: Extract<SocialWirePayload, { entity: 'chat-receipt' }>,
    connection: PeerConnection,
    correlationId: string | undefined,
  ): Promise<RemoteApplyResult> {
    const result = await this.applyRemoteChatReceipt(payload.receipt, connection.peerId);
    const hasDurableCustody =
      result.applied && (await this.replication.acquireRelayCustody(payload, connection.peerId));
    if (result.applied && !hasDurableCustody) {
      await this.replication.gossipRemotePayload(payload, connection.peerId);
    }
    await this.sendAck(payload, connection, correlationId, result);
    if (hasDurableCustody) {
      await this.replication.processPendingQueue();
    }
    return result;
  }

  private async applyRemoteChatReceipt(
    receipt: ChatReceiptV1,
    peerId: PeerId,
  ): Promise<RemoteApplyResult> {
    if (!isChatDeliveryReceipt(receipt) && !isChatReadReceipt(receipt)) {
      throw socialError('SOCIAL_CHAT_INVALID', 'Chat receipt is invalid');
    }
    const signableBytes =
      receipt.type === 'chat.delivery.receipt'
        ? getChatDeliveryReceiptSignableBytes(receipt)
        : getChatReadReceiptSignableBytes(receipt);
    if (!(await this.crypto.verify(signableBytes, receipt.signature, receipt.recipientId))) {
      throw socialError('SOCIAL_CHAT_INVALID', 'Chat receipt signature is invalid');
    }

    const firstReceipt =
      receipt.type === 'chat.delivery.receipt'
        ? await this.replication.recordChatDeliveryReceipt(receipt)
        : await this.replication.recordChatReadReceipt(receipt);
    const localPeerId = this.crypto.loadIdentity();
    let updatedLocalMessage = false;
    if (localPeerId === receipt.senderId && this.chatMessages) {
      const message = await this.chatMessages.getById(receipt.messageId);
      if (message && receiptMatchesMessage(receipt, message)) {
        if (
          receipt.type === 'chat.delivery.receipt' &&
          (message.deliveredAt === undefined || receipt.deliveredAt < message.deliveredAt)
        ) {
          await this.chatMessages.update({
            ...message,
            deliveredAt: receipt.deliveredAt,
          });
          updatedLocalMessage = true;
          this.events.emit({
            type: 'social.chat.delivery.updated',
            messageId: message.id,
            conversationId: message.conversationId,
            deliveredAt: receipt.deliveredAt,
            peerId,
            timestamp: Date.now(),
          });
        }
        if (
          receipt.type === 'chat.read.receipt' &&
          (message.readAt === undefined || receipt.readAt < message.readAt)
        ) {
          await this.chatMessages.update({
            ...message,
            deliveredAt: message.deliveredAt ?? receipt.readAt,
            readAt: receipt.readAt,
          });
          updatedLocalMessage = true;
          this.events.emit({
            type: 'social.chat.read.updated',
            messageId: message.id,
            conversationId: message.conversationId,
            readAt: receipt.readAt,
            peerId,
            timestamp: Date.now(),
          });
        }
      }
    }

    return {
      applied: firstReceipt || updatedLocalMessage,
      skipped: !firstReceipt && !updatedLocalMessage,
      conflict: false,
    };
  }

  private async resolveRemoteRecord(input: {
    entity: SocialConflictEntity;
    existing: SocialConflictRecord | null;
    incoming: SocialConflictRecord;
    existingStateHash?: string;
    incomingStateHash: string;
    peerId: string;
  }): Promise<RemoteApplyResult | null> {
    const resolution = resolveSocialConflict(input);
    if (resolution.conflict) {
      await this.persistConflictDecision(input, resolution);
      this.events.emit({
        type: 'social.conflict.detected',
        entity: input.entity,
        entityId: input.incoming.id,
        peerId: input.peerId,
        timestamp: Date.now(),
      });
      this.logger.info('remote_conflict_resolved', {
        entity: input.entity,
        entityId: input.incoming.id,
        peerId: input.peerId,
        action: resolution.action,
        reason: resolution.reason,
        winnerStateHash: resolution.winnerStateHash,
      });
    }
    if (resolution.action === 'apply') {
      return null;
    }
    return {
      applied: false,
      skipped: resolution.action === 'keep',
      conflict: resolution.action === 'reject',
    };
  }

  private async persistConflictDecision(
    input: {
      entity: SocialConflictEntity;
      incoming: SocialConflictRecord;
      existingStateHash?: string;
      incomingStateHash: string;
      peerId: string;
    },
    resolution: SocialConflictResolution,
  ): Promise<void> {
    await this.conflictDecisions?.record({
      entity: input.entity,
      entityId: input.incoming.id,
      localStateHash: input.existingStateHash,
      incomingStateHash: input.incomingStateHash,
      resolution,
      peerId: input.peerId as PeerId,
    });
  }

  private requireLocalIdentity(): PeerId {
    const identity = this.crypto.loadIdentity();
    if (!identity) {
      throw socialError('SOCIAL_POST_INVALID', 'Local identity is required');
    }
    return identity as PeerId;
  }

  private async verifyProfileSignature(
    profile: ProfileData,
    verificationCandidates: readonly string[],
  ): Promise<boolean> {
    for (const bytes of verificationCandidates) {
      if (await this.crypto.verify(bytes, profile.signature, profile.author)) {
        return true;
      }
    }
    return false;
  }

  private async requireChatRelationship(senderId: PeerId, recipientId: PeerId): Promise<void> {
    if (senderId === recipientId) {
      throw socialError('SOCIAL_CHAT_NOT_ALLOWED', 'Cannot create a chat with the local identity');
    }
    if (!this.follows) {
      throw socialError('SOCIAL_FOLLOW_STORE_UNAVAILABLE', 'Follow store is not available');
    }
    const senderFollowsRecipient = await this.follows.getByPeers(senderId, recipientId);
    const recipientFollowsSender = await this.follows.getByPeers(recipientId, senderId);
    if (senderFollowsRecipient?.deleted === false || recipientFollowsSender?.deleted === false) {
      return;
    }
    throw socialError('SOCIAL_CHAT_NOT_ALLOWED', 'Chat requires a follower relationship');
  }

  private async applyAndGossip(
    payload: SocialWirePayload,
    connection: PeerConnection,
    correlationId: string | undefined,
    result: RemoteApplyResult,
  ): Promise<RemoteApplyResult> {
    const hasDurableCustody =
      result.applied && (await this.replication.acquireRelayCustody(payload, connection.peerId));
    if (result.applied && !hasDurableCustody) {
      await this.replication.gossipRemotePayload(payload, connection.peerId);
    }
    await this.sendAck(payload, connection, correlationId, result);
    if (hasDurableCustody) {
      await this.replication.processPendingQueue();
    }
    return result;
  }

  private async sendAck(
    payload: SocialWirePayload,
    connection: PeerConnection,
    correlationId: string | undefined,
    result: RemoteApplyResult,
  ): Promise<void> {
    if (!correlationId) {
      return;
    }
    await connection.send(
      'social.ack',
      createSocialAckPayload({
        queueItemId: correlationId,
        payload,
        applied: result.applied,
        skipped: result.skipped,
        conflict: result.conflict,
        errorCode: result.conflict ? 'SOCIAL_CONFLICT' : undefined,
      }),
      { correlationId },
    );
  }
}

function socialError(code: string, message: string): AppError {
  return new AppError({
    code: 'VALIDATION_ERROR',
    message,
    safeMessage: 'Nao foi possivel concluir a acao social.',
    severity: 'warning',
    retryable: false,
    context: {
      scope: 'social.application',
      socialCode: code,
    },
  });
}

function receiptMatchesMessage(receipt: ChatReceiptV1, message: ChatMessageData): boolean {
  const receiptTimestamp =
    receipt.type === 'chat.delivery.receipt' ? receipt.deliveredAt : receipt.readAt;
  return (
    message.senderId === receipt.senderId &&
    message.recipientId === receipt.recipientId &&
    receiptTimestamp >= message.createdAt
  );
}

function getFollowId(followerId: PeerId, followingId: PeerId): string {
  return `follow_${followerId}_${followingId}`;
}
