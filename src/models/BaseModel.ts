import type { PeerId } from '../network/NetworkTypes';

/**
 * Base interface for all social domain models
 * Every model must contain: id, author, createdAt, updatedAt, signature, version
 */
export interface BaseModel {
  /** Unique identifier */
  id: string;
  /** Author peer ID */
  author: PeerId;
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
  /** Cryptographic signature */
  signature: string;
  /** Model version */
  version: string;
  /** Monotonic author-controlled revision. Missing on legacy v2 records. */
  revision?: number;
  /** Canonical hash of the immediately preceding signed revision. */
  previousRevisionHash?: string;
}

/**
 * Base class for social domain models
 * Provides common validation and serialization methods
 */
export abstract class SocialModel<T extends BaseModel> {
  protected data: T;

  constructor(data: T) {
    this.data = data;
  }

  /**
   * Get the model data
   */
  getData(): T {
    return { ...this.data };
  }

  /**
   * Get the model ID
   */
  getId(): string {
    return this.data.id;
  }

  /**
   * Get the author
   */
  getAuthor(): PeerId {
    return this.data.author;
  }

  /**
   * Get creation timestamp
   */
  getCreatedAt(): number {
    return this.data.createdAt;
  }

  /**
   * Get update timestamp
   */
  getUpdatedAt(): number {
    return this.data.updatedAt;
  }

  /**
   * Get signature
   */
  getSignature(): string {
    return this.data.signature;
  }

  /**
   * Get version
   */
  getVersion(): string {
    return this.data.version;
  }

  /**
   * Serialize to JSON
   */
  toJSON(): string {
    return JSON.stringify(this.data);
  }

  /**
   * Deserialize from JSON
   */
  static fromJSON<T extends BaseModel>(json: string): T | null {
    try {
      return JSON.parse(json) as T;
    } catch {
      return null;
    }
  }

  /**
   * Validate base model fields
   */
  protected validateBase(): boolean {
    return (
      this.data.id.length > 0 &&
      this.data.author.length > 0 &&
      this.data.createdAt > 0 &&
      this.data.updatedAt >= this.data.createdAt &&
      this.data.signature.length > 0 &&
      this.data.version.length > 0 &&
      isValidRevisionMetadata(this.data)
    );
  }

  /**
   * Validate the complete model
   */
  abstract validate(): boolean;

  /**
   * Check if model is newer than another
   */
  isNewerThan(other: SocialModel<T>): boolean {
    return this.data.updatedAt > other.getUpdatedAt();
  }

  /**
   * Check if model is equal to another
   */
  equals(other: SocialModel<T>): boolean {
    return this.data.id === other.getId();
  }
}

function isValidRevisionMetadata(data: BaseModel): boolean {
  if (data.revision === undefined) {
    return data.previousRevisionHash === undefined;
  }
  if (!Number.isSafeInteger(data.revision) || data.revision < 1) {
    return false;
  }
  if (data.revision === 1) {
    return data.previousRevisionHash === undefined;
  }
  return (
    typeof data.previousRevisionHash === 'string' &&
    /^[a-f0-9]{64}$/i.test(data.previousRevisionHash)
  );
}
