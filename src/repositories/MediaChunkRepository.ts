import { DatabaseService } from '../database/DatabaseService';
import type { MediaChunkData } from '../models/MediaChunk';

/**
 * MediaChunk repository for local SQLite storage
 */
export class MediaChunkRepository {
  private db: DatabaseService;
  private tableName = 'media_chunks';
  private initialized = false;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initializeTable();
      this.initialized = true;
    }
  }

  /**
   * Initialize media chunks table
   */
  private async initializeTable(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id TEXT PRIMARY KEY,
        author TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        signature TEXT NOT NULL,
        version TEXT NOT NULL,
        mediaObjectId TEXT NOT NULL,
        position INTEGER NOT NULL,
        size INTEGER NOT NULL,
        hash TEXT NOT NULL,
        chunkData BLOB NOT NULL
      );
    `);

    // Create indexes for common queries
    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_media_chunks_mediaObjectId ON ${this.tableName}(mediaObjectId);
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_media_chunks_position ON ${this.tableName}(position);
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_media_chunks_hash ON ${this.tableName}(hash);
    `);

    // Unique constraint to prevent duplicate chunks
    await this.db.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_media_chunks_unique ON ${this.tableName}(mediaObjectId, position);
    `);
  }

  /**
   * Create a new media chunk
   */
  async create(chunk: MediaChunkData): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      INSERT OR REPLACE INTO ${this.tableName}
      (id, author, createdAt, updatedAt, signature, version, mediaObjectId, position, size, hash, chunkData)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
      [
        chunk.id,
        chunk.author,
        chunk.createdAt,
        chunk.updatedAt,
        chunk.signature,
        chunk.version,
        chunk.mediaObjectId,
        chunk.position,
        chunk.size,
        chunk.hash,
        chunk.chunkData,
      ],
    );
  }

  /**
   * Get a chunk by ID
   */
  async getById(id: string): Promise<MediaChunkData | null> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName} WHERE id = ?;
    `,
      [id],
    );

    if (result.length === 0) {
      return null;
    }

    return this.mapRowToChunk(result[0]);
  }

  /**
   * Get chunks by media object ID
   */
  async getByMediaObjectId(mediaObjectId: string): Promise<MediaChunkData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      WHERE mediaObjectId = ?
      ORDER BY position ASC;
    `,
      [mediaObjectId],
    );

    return result.map((row) => this.mapRowToChunk(row));
  }

  /**
   * Get a specific chunk by media object ID and position
   */
  async getByPosition(mediaObjectId: string, position: number): Promise<MediaChunkData | null> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      WHERE mediaObjectId = ? AND position = ?;
    `,
      [mediaObjectId, position],
    );

    if (result.length === 0) {
      return null;
    }

    return this.mapRowToChunk(result[0]);
  }

  /**
   * Get chunk by hash
   */
  async getByHash(hash: string): Promise<MediaChunkData | null> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName} WHERE hash = ?;
    `,
      [hash],
    );

    if (result.length === 0) {
      return null;
    }

    return this.mapRowToChunk(result[0]);
  }

  /**
   * Update a chunk
   */
  async update(chunk: MediaChunkData): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      UPDATE ${this.tableName}
      SET updatedAt = ?, signature = ?, version = ?, size = ?, hash = ?, chunkData = ?
      WHERE id = ?;
    `,
      [
        chunk.updatedAt,
        chunk.signature,
        chunk.version,
        chunk.size,
        chunk.hash,
        chunk.chunkData,
        chunk.id,
      ],
    );
  }

  /**
   * Delete a chunk
   */
  async delete(id: string): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      DELETE FROM ${this.tableName} WHERE id = ?;
    `,
      [id],
    );
  }

  /**
   * Delete all chunks for a media object
   */
  async deleteByMediaObjectId(mediaObjectId: string): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      DELETE FROM ${this.tableName} WHERE mediaObjectId = ?;
    `,
      [mediaObjectId],
    );
  }

  /**
   * Get chunk count for a media object
   */
  async getCountByMediaObjectId(mediaObjectId: string): Promise<number> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT COUNT(*) as count FROM ${this.tableName}
      WHERE mediaObjectId = ?;
    `,
      [mediaObjectId],
    );
    return (result[0] as { count: number }).count;
  }

  /**
   * Get total chunk count
   */
  async getTotalCount(): Promise<number> {
    await this.ensureInitialized();
    const result = await this.db.query(`
      SELECT COUNT(*) as count FROM ${this.tableName};
    `);
    return (result[0] as { count: number }).count;
  }

  /**
   * Get total storage size
   */
  async getTotalStorageSize(): Promise<number> {
    await this.ensureInitialized();
    const result = await this.db.query(`
      SELECT SUM(size) as total FROM ${this.tableName};
    `);
    return (result[0] as { total: number | null }).total || 0;
  }

  /**
   * Get all stored chunks
   */
  async getAll(): Promise<MediaChunkData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(`
      SELECT * FROM ${this.tableName}
      ORDER BY updatedAt ASC;
    `);

    return result.map((row) => this.mapRowToChunk(row));
  }

  /**
   * Map database row to MediaChunkData
   */
  private mapRowToChunk(row: unknown): MediaChunkData {
    const r = row as {
      id: string;
      author: string;
      createdAt: number;
      updatedAt: number;
      signature: string;
      version: string;
      mediaObjectId: string;
      position: number;
      size: number;
      hash: string;
      chunkData: Uint8Array;
    };
    return {
      id: r.id,
      author: r.author,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      signature: r.signature,
      version: r.version,
      mediaObjectId: r.mediaObjectId,
      position: r.position,
      size: r.size,
      hash: r.hash,
      chunkData: r.chunkData,
    };
  }
}
