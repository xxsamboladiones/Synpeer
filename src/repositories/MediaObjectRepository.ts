import { DatabaseService } from '../database/DatabaseService';
import type { MediaObjectData } from '../models/MediaObject';

/**
 * MediaObject repository for local SQLite storage
 */
export class MediaObjectRepository {
  private db: DatabaseService;
  private tableName = 'media_objects';
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
   * Initialize media objects table
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
        type TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        hash TEXT NOT NULL,
        chunks TEXT NOT NULL,
        thumbnail TEXT,
        duration INTEGER,
        codec TEXT
      );
    `);

    // Create indexes for common queries
    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_media_objects_author ON ${this.tableName}(author);
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_media_objects_type ON ${this.tableName}(type);
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_media_objects_hash ON ${this.tableName}(hash);
    `);
  }

  /**
   * Create a new media object
   */
  async create(mediaObject: MediaObjectData): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      INSERT OR REPLACE INTO ${this.tableName}
      (id, author, createdAt, updatedAt, signature, version, type, mime, size, hash, chunks, thumbnail, duration, codec)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
      [
        mediaObject.id,
        mediaObject.author,
        mediaObject.createdAt,
        mediaObject.updatedAt,
        mediaObject.signature,
        mediaObject.version,
        mediaObject.type,
        mediaObject.mime,
        mediaObject.size,
        mediaObject.hash,
        JSON.stringify(mediaObject.chunks),
        mediaObject.thumbnail || null,
        mediaObject.duration || null,
        mediaObject.codec || null,
      ],
    );
  }

  /**
   * Get a media object by ID
   */
  async getById(id: string): Promise<MediaObjectData | null> {
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

    return this.mapRowToMediaObject(result[0]);
  }

  /**
   * Get media objects by author
   */
  async getByAuthor(
    author: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<MediaObjectData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      WHERE author = ?
      ORDER BY createdAt DESC
      LIMIT ? OFFSET ?;
    `,
      [author, limit, offset],
    );

    return result.map((row) => this.mapRowToMediaObject(row));
  }

  /**
   * Get media objects by type
   */
  async getByType(
    type: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<MediaObjectData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      WHERE type = ?
      ORDER BY createdAt DESC
      LIMIT ? OFFSET ?;
    `,
      [type, limit, offset],
    );

    return result.map((row) => this.mapRowToMediaObject(row));
  }

  /**
   * Get media object by hash
   */
  async getByHash(hash: string): Promise<MediaObjectData | null> {
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

    return this.mapRowToMediaObject(result[0]);
  }

  /**
   * Update a media object
   */
  async update(mediaObject: MediaObjectData): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      UPDATE ${this.tableName}
      SET updatedAt = ?, signature = ?, version = ?, type = ?, mime = ?, size = ?, hash = ?, chunks = ?, thumbnail = ?, duration = ?, codec = ?
      WHERE id = ?;
    `,
      [
        mediaObject.updatedAt,
        mediaObject.signature,
        mediaObject.version,
        mediaObject.type,
        mediaObject.mime,
        mediaObject.size,
        mediaObject.hash,
        JSON.stringify(mediaObject.chunks),
        mediaObject.thumbnail || null,
        mediaObject.duration || null,
        mediaObject.codec || null,
        mediaObject.id,
      ],
    );
  }

  /**
   * Delete a media object
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
   * Get all media objects
   */
  async getAll(limit: number = 50, offset: number = 0): Promise<MediaObjectData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      ORDER BY createdAt DESC
      LIMIT ? OFFSET ?;
    `,
      [limit, offset],
    );

    return result.map((row) => this.mapRowToMediaObject(row));
  }

  /**
   * Get media object count
   */
  async getCount(author?: string): Promise<number> {
    await this.ensureInitialized();
    if (author) {
      const result = await this.db.query(
        `
        SELECT COUNT(*) as count FROM ${this.tableName}
        WHERE author = ?;
      `,
        [author],
      );
      return (result[0] as { count: number }).count;
    }

    const result = await this.db.query(`
      SELECT COUNT(*) as count FROM ${this.tableName};
    `);
    return (result[0] as { count: number }).count;
  }

  /**
   * Get media object count by type
   */
  async getCountByType(type: string): Promise<number> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT COUNT(*) as count FROM ${this.tableName}
      WHERE type = ?;
    `,
      [type],
    );
    return (result[0] as { count: number }).count;
  }

  /**
   * Map database row to MediaObjectData
   */
  private mapRowToMediaObject(row: unknown): MediaObjectData {
    const r = row as {
      id: string;
      author: string;
      createdAt: number;
      updatedAt: number;
      signature: string;
      version: string;
      type: string;
      mime: string;
      size: number;
      hash: string;
      chunks: string;
      thumbnail: string | null;
      duration: number | null;
      codec: string | null;
    };
    return {
      id: r.id,
      author: r.author,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      signature: r.signature,
      version: r.version,
      type: r.type as 'video' | 'audio' | 'image' | 'document',
      mime: r.mime,
      size: r.size,
      hash: r.hash,
      chunks: JSON.parse(r.chunks) as string[],
      thumbnail: r.thumbnail || undefined,
      duration: r.duration || undefined,
      codec: r.codec || undefined,
    };
  }
}
