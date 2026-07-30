import type { PeerId } from '../network/NetworkTypes';
import { BaseModel, SocialModel } from './BaseModel';
import { CIDGenerator } from '../crypto/CIDGenerator';
import type { MediaObjectData } from './MediaObject';

export type PostMediaAttachment = Pick<
  MediaObjectData,
  'id' | 'type' | 'mime' | 'size' | 'hash' | 'chunks'
> & {
  name?: string;
};

/**
 * Post domain model
 */
export interface PostData extends BaseModel {
  id: string;
  author: PeerId;
  createdAt: number;
  updatedAt: number;
  signature: string;
  version: string;
  /** Post text content */
  text: string;
  /** Content hash for deduplication */
  contentHash: string;
  /** Reply to post ID (optional) */
  replyTo?: string;
  /** Media attachments stored in the distributed media layer */
  mediaAttachments?: PostMediaAttachment[];
  /** Soft delete flag */
  deleted: boolean;
}

/**
 * Post model
 */
export class Post extends SocialModel<PostData> {
  constructor(data: PostData) {
    super(data);
  }

  /**
   * Get post text
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
   * Get reply to post ID
   */
  getReplyTo(): string | undefined {
    return this.data.replyTo;
  }

  /**
   * Check if post is deleted
   */
  isDeleted(): boolean {
    return this.data.deleted;
  }

  /**
   * Validate post model
   */
  validate(): boolean {
    return (
      this.validateBase() &&
      (this.data.deleted ||
        this.data.text.length > 0 ||
        (this.data.mediaAttachments?.length ?? 0) > 0) &&
      this.data.contentHash.length > 0
    );
  }

  /**
   * Create a new post with CID-based ID
   */
  static async create(
    author: PeerId,
    text: string,
    replyTo?: string,
    mediaAttachments: PostMediaAttachment[] = [],
  ): Promise<Post> {
    const now = Date.now();
    const contentHash = await Post.generateContentHash(text, author, now, mediaAttachments);

    // Generate CID-based ID for consistency across peers
    const id = await CIDGenerator.generatePostCID(
      author,
      now,
      `${text}:${JSON.stringify(mediaAttachments)}`,
    );

    return new Post({
      id,
      author,
      createdAt: now,
      updatedAt: now,
      signature: contentHash,
      version: '1.0.0',
      text,
      contentHash,
      replyTo,
      mediaAttachments,
      deleted: false,
    });
  }

  /**
   * Generate content hash for deduplication using SHA256
   */
  private static async generateContentHash(
    text: string,
    author: PeerId,
    timestamp: number,
    mediaAttachments: PostMediaAttachment[],
  ): Promise<string> {
    const data = `${text}:${author}:${timestamp}:${JSON.stringify(mediaAttachments)}`;
    const hash = await CIDGenerator.generateCID(data);
    return hash;
  }

  /**
   * Soft delete post
   */
  softDelete(): Post {
    return new Post({
      ...this.data,
      deleted: true,
      updatedAt: Date.now(),
    });
  }
}
