import type { PeerId } from '../network/NetworkTypes';
import { BaseModel, SocialModel } from './BaseModel';

/**
 * Follow domain model
 */
export interface FollowData extends BaseModel {
  id: string;
  author: PeerId;
  createdAt: number;
  updatedAt: number;
  signature: string;
  version: string;
  /** Follower peer ID */
  followerId: PeerId;
  /** Following peer ID */
  followingId: PeerId;
  /** Soft delete flag (unfollow) */
  deleted: boolean;
}

/**
 * Follow model
 */
export class Follow extends SocialModel<FollowData> {
  constructor(data: FollowData) {
    super(data);
  }

  /**
   * Get follower ID
   */
  getFollowerId(): PeerId {
    return this.data.followerId;
  }

  /**
   * Get following ID
   */
  getFollowingId(): PeerId {
    return this.data.followingId;
  }

  /**
   * Check if follow is deleted (unfollowed)
   */
  isDeleted(): boolean {
    return this.data.deleted;
  }

  /**
   * Validate follow model
   */
  validate(): boolean {
    return (
      this.validateBase() &&
      this.data.followerId.length > 0 &&
      this.data.followingId.length > 0 &&
      this.data.followerId !== this.data.followingId
    );
  }

  /**
   * Create a new follow relationship
   */
  static create(followerId: PeerId, followingId: PeerId): Follow {
    const now = Date.now();
    const id = `follow_${followerId}_${followingId}`;

    return new Follow({
      id,
      author: followerId,
      createdAt: now,
      updatedAt: now,
      signature: '', // To be filled by signing process
      version: '1.0.0',
      followerId,
      followingId,
      deleted: false,
    });
  }

  /**
   * Unfollow (soft delete)
   */
  unfollow(): Follow {
    return new Follow({
      ...this.data,
      deleted: true,
      updatedAt: Date.now(),
    });
  }
}
