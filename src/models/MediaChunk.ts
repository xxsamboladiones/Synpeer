import { BaseModel, SocialModel } from './BaseModel';
import type { PeerId } from '../network/NetworkTypes';
import { MediaIntegrityService } from '../services/media/MediaIntegrityService';

/**
 * Media chunk data interface
 */
export interface MediaChunkData extends BaseModel {
  mediaObjectId: string; // Reference to the parent MediaObject
  position: number; // Position in the sequence (0, 1, 2, ...)
  size: number; // Size of this chunk in bytes
  hash: string; // Hash of the chunk data
  chunkData: Uint8Array; // The actual chunk data
}

/**
 * MediaChunk represents a single chunk of a media object
 * - Files are split into chunks for P2P distribution
 * - Each chunk is signed and verified independently
 * - Similar to BitTorrent/IPFS chunking approach
 */
export class MediaChunk extends SocialModel<MediaChunkData> {
  public readonly mediaObjectId: string;
  public readonly position: number;
  public readonly size: number;
  public readonly hash: string;
  public readonly chunkData: Uint8Array;

  constructor(data: MediaChunkData) {
    super(data);
    this.mediaObjectId = data.mediaObjectId;
    this.position = data.position;
    this.size = data.size;
    this.hash = data.hash;
    this.chunkData = data.chunkData;
  }

  /**
   * Create a new media chunk with deterministic ID
   */
  static create(
    mediaObjectId: string,
    position: number,
    chunkData: Uint8Array,
    author: PeerId,
  ): MediaChunk {
    const now = Date.now();
    const size = chunkData.length;
    const hash = MediaIntegrityService.hashBytes(chunkData);

    const id = MediaIntegrityService.createChunkId(mediaObjectId, position, hash);

    return new MediaChunk({
      id,
      author,
      mediaObjectId,
      position,
      size,
      hash,
      chunkData,
      createdAt: now,
      updatedAt: now,
      signature: '', // Will be signed by the owner
      version: '1.0',
    });
  }

  /**
   * Calculate hash of chunk data using SHA256 (sync version for compatibility)
   */
  private static calculateHashSync(chunkData: Uint8Array): string {
    return MediaIntegrityService.hashBytes(chunkData);
  }

  /**
   * Calculate hash of chunk data using SHA256 (async version)
   */
  static async calculateHash(chunkData: Uint8Array): Promise<string> {
    return MediaIntegrityService.hashBytes(chunkData);
  }

  /**
   * Validate chunk data
   */
  validate(): boolean {
    // Validate base fields
    if (!this.validateBase()) {
      return false;
    }

    // Validate required fields
    if (!this.mediaObjectId || !this.hash) {
      return false;
    }

    // Validate position
    if (this.position < 0) {
      return false;
    }

    // Validate size
    if (this.size <= 0) {
      return false;
    }

    // Validate data
    if (!this.chunkData || this.chunkData.length === 0) {
      return false;
    }

    // Validate data size matches declared size
    if (this.chunkData.length !== this.size) {
      return false;
    }

    // Validate hash matches data (using sync hash for compatibility)
    const calculatedHash = MediaChunk.calculateHashSync(this.chunkData);
    if (calculatedHash !== this.hash) {
      return false;
    }

    return true;
  }

  /**
   * Get data as plain object
   */
  getData(): MediaChunkData {
    return {
      id: this.getId(),
      author: this.getAuthor(),
      mediaObjectId: this.mediaObjectId,
      position: this.position,
      size: this.size,
      hash: this.hash,
      chunkData: this.chunkData,
      createdAt: this.getCreatedAt(),
      updatedAt: this.getUpdatedAt(),
      signature: this.getSignature(),
      version: this.getVersion(),
    };
  }

  /**
   * Deserialize from JSON
   */
  static fromMediaChunkJSON(json: string, chunkData: Uint8Array): MediaChunk | null {
    const chunkDataObj = SocialModel.fromJSON<MediaChunkData>(json);
    if (!chunkDataObj) {
      return null;
    }
    return new MediaChunk({
      ...chunkDataObj,
      chunkData,
    });
  }

  /**
   * Verify chunk integrity
   */
  verifyIntegrity(): boolean {
    const calculatedHash = MediaChunk.calculateHashSync(this.chunkData);
    return calculatedHash === this.hash;
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
   * Convert chunk data to base64 string
   */
  toBase64(): string {
    // Convert Uint8Array to base64
    let binary = '';
    for (let i = 0; i < this.chunkData.length; i++) {
      binary += String.fromCharCode(this.chunkData[i]);
    }
    // eslint-disable-next-line no-undef
    return btoa(binary);
  }

  /**
   * Create chunk from base64 string
   */
  static fromBase64(
    base64: string,
    mediaObjectId: string,
    position: number,
    author: PeerId,
  ): MediaChunk {
    // eslint-disable-next-line no-undef
    const binary = atob(base64);
    const chunkData = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      chunkData[i] = binary.charCodeAt(i);
    }
    return MediaChunk.create(mediaObjectId, position, chunkData, author);
  }
}
