import type { PeerId } from '../network/NetworkTypes';
import { BaseModel, SocialModel } from './BaseModel';

/**
 * Comment domain model
 */
export interface CommentData extends BaseModel {
  id: string;
  author: PeerId;
  createdAt: number;
  updatedAt: number;
  signature: string;
  version: string;
  /** Parent post ID */
  postId: string;
  /** Comment text */
  text: string;
  /** Content hash for deduplication */
  contentHash: string;
  /** Parent comment ID (for nested replies) */
  parentCommentId?: string;
  /** Soft delete flag */
  deleted: boolean;
}

/**
 * Comment model
 */
export class Comment extends SocialModel<CommentData> {
  constructor(data: CommentData) {
    super(data);
  }

  /**
   * Get parent post ID
   */
  getPostId(): string {
    return this.data.postId;
  }

  /**
   * Get comment text
   */
  getText(): string {
    return this.data.text;
  }

  /**
   * Get content hash
   */
  getContentHash(): string {
    return this.data.contentHash;
  }

  /**
   * Get parent comment ID
   */
  getParentCommentId(): string | undefined {
    return this.data.parentCommentId;
  }

  /**
   * Check if comment is deleted
   */
  isDeleted(): boolean {
    return this.data.deleted;
  }

  /**
   * Validate comment model
   */
  validate(): boolean {
    return (
      this.validateBase() &&
      this.data.postId.length > 0 &&
      this.data.text.length > 0 &&
      this.data.contentHash.length > 0
    );
  }

  /**
   * Create a new comment
   */
  static create(author: PeerId, postId: string, text: string, parentCommentId?: string): Comment {
    const now = Date.now();
    const id = `comment_${author}_${now}`;
    const contentHash = Comment.generateContentHash(text, postId, author, now);

    return new Comment({
      id,
      author,
      createdAt: now,
      updatedAt: now,
      signature: '', // To be filled by signing process
      version: '1.0.0',
      postId,
      text,
      contentHash,
      parentCommentId,
      deleted: false,
    });
  }

  /**
   * Generate content hash for deduplication
   */
  private static generateContentHash(
    text: string,
    postId: string,
    author: PeerId,
    timestamp: number,
  ): string {
    const data = `${text}:${postId}:${author}:${timestamp}`;
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16).padStart(16, '0');
  }

  /**
   * Soft delete comment
   */
  softDelete(): Comment {
    return new Comment({
      ...this.data,
      deleted: true,
      updatedAt: Date.now(),
    });
  }
}
