import type { PeerId } from '../network/NetworkTypes';
import { BaseModel, SocialModel } from './BaseModel';

/**
 * Profile domain model
 */
export interface ProfileData extends BaseModel {
  id: string;
  author: PeerId;
  createdAt: number;
  updatedAt: number;
  signature: string;
  version: string;
  /** Username */
  username: string;
  /** Display name */
  displayName: string;
  /** Bio */
  bio?: string;
  /** Avatar hash */
  avatarHash?: string;
  /** Post count */
  postCount: number;
  /** Follower count */
  followerCount: number;
  /** Following count */
  followingCount: number;
}

/**
 * Profile model
 */
export class Profile extends SocialModel<ProfileData> {
  constructor(data: ProfileData) {
    super(data);
  }

  /**
   * Get username
   */
  getUsername(): string {
    return this.data.username;
  }

  /**
   * Get display name
   */
  getDisplayName(): string {
    return this.data.displayName;
  }

  /**
   * Get bio
   */
  getBio(): string | undefined {
    return this.data.bio;
  }

  /**
   * Get avatar hash
   */
  getAvatarHash(): string | undefined {
    return this.data.avatarHash;
  }

  /**
   * Get post count
   */
  getPostCount(): number {
    return this.data.postCount;
  }

  /**
   * Get follower count
   */
  getFollowerCount(): number {
    return this.data.followerCount;
  }

  /**
   * Get following count
   */
  getFollowingCount(): number {
    return this.data.followingCount;
  }

  /**
   * Validate profile model
   */
  validate(): boolean {
    return (
      this.validateBase() &&
      this.data.username.length > 0 &&
      this.data.displayName.length > 0 &&
      this.data.postCount >= 0 &&
      this.data.followerCount >= 0 &&
      this.data.followingCount >= 0
    );
  }

  /**
   * Create a new profile
   */
  static create(
    author: PeerId,
    username: string,
    displayName: string,
    bio?: string,
    avatarHash?: string,
  ): Profile {
    const now = Date.now();
    const id = `profile_${author}`;

    return new Profile({
      id,
      author,
      createdAt: now,
      updatedAt: now,
      signature: '', // To be filled by signing process
      version: '1.0.0',
      username,
      displayName,
      bio,
      avatarHash,
      postCount: 0,
      followerCount: 0,
      followingCount: 0,
    });
  }

  /**
   * Update profile
   */
  update(
    updates: Partial<Omit<ProfileData, 'id' | 'author' | 'createdAt' | 'signature' | 'version'>>,
  ): Profile {
    return new Profile({
      ...this.data,
      ...updates,
      updatedAt: Date.now(),
    });
  }
}
