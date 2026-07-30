import { MediaChunk, type MediaChunkData } from '../../models/MediaChunk';
import { MediaObject, type MediaObjectData, type MediaType } from '../../models/MediaObject';
import type { PeerId } from '../../network/NetworkTypes';
import type { MediaChunkRepository } from '../../repositories/MediaChunkRepository';
import type { MediaObjectRepository } from '../../repositories/MediaObjectRepository';

import { MediaIntegrityService } from './MediaIntegrityService';

export interface MediaServiceConfig {
  defaultChunkSize: number;
}

export const defaultMediaServiceConfig: MediaServiceConfig = {
  defaultChunkSize: 64 * 1024,
};

export interface MediaServiceResult {
  success: boolean;
  mediaObject?: MediaObjectData;
  fileData?: Uint8Array;
  error?: string;
}

/**
 * Owns local media ingestion and validated reads.
 * Remote transfer is exclusively handled by PeerMediaSyncService.
 */
export class MediaService {
  private readonly config: MediaServiceConfig;

  constructor(
    private readonly mediaObjectRepository: MediaObjectRepository,
    private readonly mediaChunkRepository: MediaChunkRepository,
    config: MediaServiceConfig = defaultMediaServiceConfig,
    private readonly integrityService: MediaIntegrityService = new MediaIntegrityService(),
  ) {
    if (!Number.isSafeInteger(config.defaultChunkSize) || config.defaultChunkSize <= 0) {
      throw new Error('Media chunk size must be a positive safe integer');
    }
    this.config = config;
  }

  async uploadMedia(
    author: PeerId,
    type: MediaType,
    mime: string,
    fileData: Uint8Array,
    thumbnail?: string,
    duration?: number,
    codec?: string,
  ): Promise<MediaServiceResult> {
    try {
      if (fileData.length === 0) {
        return {
          success: false,
          error: 'File data cannot be empty',
        };
      }

      const hash = MediaIntegrityService.hashBytes(fileData);
      const mediaObjectId = `media_${hash}`;
      const chunks = this.chunkFile(mediaObjectId, fileData, author);
      const now = Date.now();
      const mediaObject = new MediaObject({
        id: mediaObjectId,
        author,
        type,
        mime,
        size: fileData.length,
        hash,
        chunks: chunks.map((chunk) => chunk.getId()),
        thumbnail,
        duration,
        codec,
        createdAt: now,
        updatedAt: now,
        signature: '',
        version: '1.0',
      }).getData();

      for (const chunk of chunks) {
        await this.mediaChunkRepository.create(chunk.getData());
      }
      await this.mediaObjectRepository.create(mediaObject);

      return {
        success: true,
        mediaObject,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown media ingestion error',
      };
    }
  }

  async getMediaObject(mediaObjectId: string): Promise<MediaObjectData | null> {
    return await this.mediaObjectRepository.getById(mediaObjectId);
  }

  async getLocalMediaBytes(mediaObjectId: string): Promise<MediaServiceResult> {
    try {
      const mediaObject = await this.mediaObjectRepository.getById(mediaObjectId);
      if (!mediaObject) {
        return {
          success: false,
          error: 'Media object not found',
        };
      }

      const chunks = await this.mediaChunkRepository.getByMediaObjectId(mediaObjectId);
      const integrity = this.integrityService.inspectMedia(mediaObject, chunks);
      await this.removeInvalidChunks(integrity.invalidChunks);
      if (!integrity.available || !integrity.fileData) {
        return {
          success: false,
          mediaObject,
          error: integrity.complete
            ? 'Media failed final integrity validation'
            : 'Media chunks are not fully available locally',
        };
      }

      return {
        success: true,
        mediaObject,
        fileData: integrity.fileData,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown local media read error',
      };
    }
  }

  async getMediaObjectsByAuthor(
    author: string,
    limit = 50,
    offset = 0,
  ): Promise<MediaObjectData[]> {
    return await this.mediaObjectRepository.getByAuthor(author, limit, offset);
  }

  async getMediaObjectsByType(type: string, limit = 50, offset = 0): Promise<MediaObjectData[]> {
    return await this.mediaObjectRepository.getByType(type, limit, offset);
  }

  reassembleChunksForTest(chunks: MediaChunkData[]): Uint8Array {
    return this.integrityService.reassemble(chunks);
  }

  validateFileForTest(mediaObject: MediaObjectData, chunks: MediaChunkData[]): boolean {
    return this.integrityService.inspectMedia(mediaObject, chunks).available;
  }

  private chunkFile(mediaObjectId: string, fileData: Uint8Array, author: PeerId): MediaChunk[] {
    const chunks: MediaChunk[] = [];
    const totalChunks = Math.ceil(fileData.length / this.config.defaultChunkSize);

    for (let position = 0; position < totalChunks; position += 1) {
      const start = position * this.config.defaultChunkSize;
      const end = Math.min(start + this.config.defaultChunkSize, fileData.length);
      chunks.push(MediaChunk.create(mediaObjectId, position, fileData.slice(start, end), author));
    }
    return chunks;
  }

  private async removeInvalidChunks(invalidChunks: readonly { chunkId: string }[]): Promise<void> {
    for (const chunk of invalidChunks) {
      if (chunk.chunkId) {
        await this.mediaChunkRepository.delete(chunk.chunkId);
      }
    }
  }
}
