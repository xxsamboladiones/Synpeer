import type { PeerId } from '../network/NetworkTypes';
import { BaseModel, SocialModel } from './BaseModel';

/**
 * Reaction types
 */
export type ReactionType = 'like';

/**
 * Reaction domain model
 */
export interface ReactionData extends BaseModel {
  id: string;
  author: PeerId;
  createdAt: number;
  updatedAt: number;
  signature: string;
  version: string;
  /** Target post ID */
  postId: string;
  /** Target comment ID (optional) */
  commentId?: string;
  /** Reaction type */
  reactionType: ReactionType;
  /** Soft delete flag (unreact) */
  deleted: boolean;
}

/**
 * Reaction model
 */
export class Reaction extends SocialModel<ReactionData> {
  constructor(data: ReactionData) {
    super(data);
  }

  /**
   * Get target post ID
   */
  getPostId(): string {
    return this.data.postId;
  }

  /**
   * Get target comment ID
   */
  getCommentId(): string | undefined {
    return this.data.commentId;
  }

  /**
   * Get reaction type
   */
  getReactionType(): ReactionType {
    return this.data.reactionType;
  }

  /**
   * Check if reaction is deleted (unreacted)
   */
  isDeleted(): boolean {
    return this.data.deleted;
  }

  /**
   * Validate reaction model
   */
  validate(): boolean {
    return this.validateBase() && this.data.postId.length > 0 && this.data.reactionType === 'like';
  }

  /**
   * Create a new reaction
   */
  static create(
    author: PeerId,
    postId: string,
    reactionType: ReactionType = 'like',
    commentId?: string,
  ): Reaction {
    const now = Date.now();
    const id = `reaction_${author}_${postId}_${commentId || 'post'}_${now}`;

    return new Reaction({
      id,
      author,
      createdAt: now,
      updatedAt: now,
      signature: '', // To be filled by signing process
      version: '1.0.0',
      postId,
      commentId,
      reactionType,
      deleted: false,
    });
  }

  /**
   * Unreact (soft delete)
   */
  unreact(): Reaction {
    return new Reaction({
      ...this.data,
      deleted: true,
      updatedAt: Date.now(),
    });
  }
}
