import { BaseModel, SocialModel } from './BaseModel';
import type { PeerId } from '../network/NetworkTypes';
import { CIDGenerator } from '../crypto/CIDGenerator';

/**
 * Media types supported by the distributed media layer
 */
export type MediaType = 'video' | 'audio' | 'image' | 'document';

/**
 * Media object data interface
 */
export interface MediaObjectData extends BaseModel {
  type: MediaType;
  mime: string;
  size: number;
  hash: string;
  chunks: string[]; // Array of chunk IDs
  thumbnail?: string; // Hash of thumbnail image
  duration?: number; // Duration in seconds (for video/audio)
  codec?: string; // Codec information (for video/audio)
}

/**
 * MediaObject represents a distributed media object
 * - Files are split into chunks for P2P distribution
 * - Each chunk is signed and verified independently
 * - Similar to BitTorrent/IPFS chunking approach
 */
export class MediaObject extends SocialModel<MediaObjectData> {
  public readonly type: MediaType;
  public readonly mime: string;
  public readonly size: number;
  public readonly hash: string;
  public readonly chunks: string[];
  public readonly thumbnail?: string;
  public readonly duration?: number;
  public readonly codec?: string;

  constructor(data: MediaObjectData) {
    super(data);
    this.type = data.type;
    this.mime = data.mime;
    this.size = data.size;
    this.hash = data.hash;
    this.chunks = data.chunks;
    this.thumbnail = data.thumbnail;
    this.duration = data.duration;
    this.codec = data.codec;
  }

  /**
   * Create a new media object with CID-based ID
   */
  static async create(
    owner: PeerId,
    type: MediaType,
    mime: string,
    size: number,
    hash: string,
    chunks: string[],
    thumbnail?: string,
    duration?: number,
    codec?: string,
  ): Promise<MediaObject> {
    const now = Date.now();

    // Generate CID-based ID for consistency across peers
    const id = await CIDGenerator.generateMediaCID(hash, mime, size);

    return new MediaObject({
      id,
      author: owner,
      type,
      mime,
      size,
      hash,
      chunks,
      thumbnail,
      duration,
      codec,
      createdAt: now,
      updatedAt: now,
      signature: '', // Will be signed by the owner
      version: '1.0',
    });
  }

  /**
   * Validate media object data
   */
  validate(): boolean {
    // Validate base fields
    if (!this.validateBase()) {
      return false;
    }

    // Validate required fields
    if (!this.type || !this.mime || !this.hash) {
      return false;
    }

    // Validate size
    if (this.size <= 0) {
      return false;
    }

    // Validate chunks
    if (!Array.isArray(this.chunks) || this.chunks.length === 0) {
      return false;
    }

    // Validate media type
    const validTypes: MediaType[] = ['video', 'audio', 'image', 'document'];
    if (!validTypes.includes(this.type)) {
      return false;
    }

    return true;
  }

  /**
   * Get data as plain object
   */
  getData(): MediaObjectData {
    return {
      id: this.getId(),
      author: this.getAuthor(),
      type: this.type,
      mime: this.mime,
      size: this.size,
      hash: this.hash,
      chunks: this.chunks,
      thumbnail: this.thumbnail,
      duration: this.duration,
      codec: this.codec,
      createdAt: this.getCreatedAt(),
      updatedAt: this.getUpdatedAt(),
      signature: this.getSignature(),
      version: this.getVersion(),
    };
  }

  /**
   * Deserialize from JSON
   */
  static fromMediaObjectJSON(json: string): MediaObject | null {
    const data = SocialModel.fromJSON<MediaObjectData>(json);
    if (!data) {
      return null;
    }
    return new MediaObject(data);
  }

  /**
   * Check if media object is video
   */
  isVideo(): boolean {
    return this.type === 'video';
  }

  /**
   * Check if media object is audio
   */
  isAudio(): boolean {
    return this.type === 'audio';
  }

  /**
   * Check if media object is image
   */
  isImage(): boolean {
    return this.type === 'image';
  }

  /**
   * Check if media object is document
   */
  isDocument(): boolean {
    return this.type === 'document';
  }

  /**
   * Get total number of chunks
   */
  getTotalChunks(): number {
    return this.chunks.length;
  }

  /**
   * Get human-readable size
   */
  getHumanReadableSize(): string {
    const bytes = this.size;
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  /**
   * Get human-readable duration
   */
  getHumanReadableDuration(): string {
    if (!this.duration) {
      return 'N/A';
    }

    const hours = Math.floor(this.duration / 3600);
    const minutes = Math.floor((this.duration % 3600) / 60);
    const seconds = Math.floor(this.duration % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }
}
