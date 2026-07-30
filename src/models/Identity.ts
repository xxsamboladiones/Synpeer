import type { PeerId } from '../network/NetworkTypes';
import { BaseModel, SocialModel } from './BaseModel';

/**
 * Identity domain model
 */
export interface IdentityData extends BaseModel {
  id: string;
  author: PeerId;
  createdAt: number;
  updatedAt: number;
  signature: string;
  version: string;
  /** Public identity string */
  publicIdentity: string;
  /** Username */
  username?: string;
  /** Display name */
  displayName?: string;
}

/**
 * Identity model
 */
export class Identity extends SocialModel<IdentityData> {
  constructor(data: IdentityData) {
    super(data);
  }

  /**
   * Get public identity
   */
  getPublicIdentity(): string {
    return this.data.publicIdentity;
  }

  /**
   * Get username
   */
  getUsername(): string | undefined {
    return this.data.username;
  }

  /**
   * Get display name
   */
  getDisplayName(): string | undefined {
    return this.data.displayName;
  }

  /**
   * Validate identity model
   */
  validate(): boolean {
    return this.validateBase() && this.data.publicIdentity.length > 0;
  }

  /**
   * Create a new identity
   */
  static create(
    publicIdentity: string,
    author: PeerId,
    username?: string,
    displayName?: string,
  ): Identity {
    const now = Date.now();
    const id = `identity_${author}_${now}`;

    return new Identity({
      id,
      author,
      createdAt: now,
      updatedAt: now,
      signature: '', // To be filled by signing process
      version: '1.0.0',
      publicIdentity,
      username,
      displayName,
    });
  }
}
