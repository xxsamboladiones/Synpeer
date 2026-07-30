import { DatabaseService } from '../database/DatabaseService';
import type { PostData } from '../models/Post';
import { createLogger } from '../observability/Logger';

/**
 * Post repository for local SQLite storage
 */
export class PostRepository {
  private db: DatabaseService;
  private tableName = 'posts';
  private initialized = false;
  private readonly logger = createLogger('PostRepository');

  constructor(db: DatabaseService) {
    this.db = db;
  }

  /**
   * Ensure table is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      try {
        await this.initializeTable();
        this.initialized = true;
        this.logger.info('table_initialized');
      } catch (error) {
        this.logger.error('table_initialization_failed', error);
        throw error;
      }
    }
  }

  /**
   * Initialize posts table (private method)
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
        text TEXT NOT NULL,
        contentHash TEXT NOT NULL,
        mediaAttachments TEXT,
        replyTo TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        revision INTEGER,
        previousRevisionHash TEXT
      );
    `);

    await this.db
      .execute(
        `
      ALTER TABLE ${this.tableName} ADD COLUMN mediaAttachments TEXT;
    `,
      )
      .catch(() => undefined);
    await this.db
      .execute(`ALTER TABLE ${this.tableName} ADD COLUMN revision INTEGER;`)
      .catch(() => undefined);
    await this.db
      .execute(`ALTER TABLE ${this.tableName} ADD COLUMN previousRevisionHash TEXT;`)
      .catch(() => undefined);

    // Create indexes for common queries
    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_posts_author ON ${this.tableName}(author);
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_posts_createdAt ON ${this.tableName}(createdAt DESC);
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_posts_contentHash ON ${this.tableName}(contentHash);
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_posts_replyTo ON ${this.tableName}(replyTo);
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_posts_deleted ON ${this.tableName}(deleted);
    `);
  }

  /**
   * Create a new post
   */
  async create(post: PostData): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      INSERT OR REPLACE INTO ${this.tableName}
      (id, author, createdAt, updatedAt, signature, version, text, contentHash, mediaAttachments, replyTo, deleted, revision, previousRevisionHash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
      [
        post.id,
        post.author,
        post.createdAt,
        post.updatedAt,
        post.signature,
        post.version,
        post.text,
        post.contentHash,
        JSON.stringify(post.mediaAttachments ?? []),
        post.replyTo || null,
        post.deleted ? 1 : 0,
        post.revision ?? null,
        post.previousRevisionHash ?? null,
      ],
    );
  }

  /**
   * Get a post by ID
   */
  async getById(id: string): Promise<PostData | null> {
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

    return this.mapRowToPost(result[0]);
  }

  /**
   * Get posts by author
   */
  async getByAuthor(author: string, limit: number = 50, offset: number = 0): Promise<PostData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      WHERE author = ? AND deleted = 0
      ORDER BY createdAt DESC
      LIMIT ? OFFSET ?;
    `,
      [author, limit, offset],
    );

    return result.map((row) => this.mapRowToPost(row));
  }

  /**
   * Get all posts (non-deleted)
   */
  async getAll(limit: number = 50, offset: number = 0): Promise<PostData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      WHERE deleted = 0
      ORDER BY createdAt DESC
      LIMIT ? OFFSET ?;
    `,
      [limit, offset],
    );

    return result.map((row) => this.mapRowToPost(row));
  }

  async getAllIncludingDeleted(limit: number = 1000, offset: number = 0): Promise<PostData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      WHERE deleted IN (0, 1)
      ORDER BY updatedAt ASC
      LIMIT ? OFFSET ?;
    `,
      [limit, offset],
    );
    return result.map((row) => this.mapRowToPost(row));
  }

  async getAllForSync(): Promise<PostData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(`
      SELECT * FROM ${this.tableName}
      WHERE deleted IN (0, 1)
      ORDER BY updatedAt ASC;
    `);
    return result.map((row) => this.mapRowToPost(row));
  }

  /**
   * Get posts by content hash (for deduplication)
   */
  async getByContentHash(contentHash: string): Promise<PostData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      WHERE contentHash = ?;
    `,
      [contentHash],
    );

    return result.map((row) => this.mapRowToPost(row));
  }

  /**
   * Get replies to a post
   */
  async getReplies(postId: string, limit: number = 50, offset: number = 0): Promise<PostData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      WHERE replyTo = ? AND deleted = 0
      ORDER BY createdAt DESC
      LIMIT ? OFFSET ?;
    `,
      [postId, limit, offset],
    );

    return result.map((row) => this.mapRowToPost(row));
  }

  /**
   * Update a post
   */
  async update(post: PostData): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      UPDATE ${this.tableName}
      SET updatedAt = ?, signature = ?, version = ?, text = ?, contentHash = ?, mediaAttachments = ?, deleted = ?, revision = ?, previousRevisionHash = ?
      WHERE id = ?;
    `,
      [
        post.updatedAt,
        post.signature,
        post.version,
        post.text,
        post.contentHash,
        JSON.stringify(post.mediaAttachments ?? []),
        post.deleted ? 1 : 0,
        post.revision ?? null,
        post.previousRevisionHash ?? null,
        post.id,
      ],
    );
  }

  /**
   * Soft delete a post
   */
  async softDelete(id: string): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      UPDATE ${this.tableName}
      SET deleted = 1, updatedAt = ?
      WHERE id = ?;
    `,
      [Date.now(), id],
    );
  }

  /**
   * Delete a post permanently
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
   * Get post count
   */
  async getCount(author?: string): Promise<number> {
    await this.ensureInitialized();
    if (author) {
      const result = await this.db.query(
        `
        SELECT COUNT(*) as count FROM ${this.tableName}
        WHERE author = ? AND deleted = 0;
      `,
        [author],
      );
      return (result[0] as { count: number }).count;
    }

    const result = await this.db.query(`
      SELECT COUNT(*) as count FROM ${this.tableName} WHERE deleted = 0;
    `);
    return (result[0] as { count: number }).count;
  }

  /**
   * Map database row to PostData
   */
  private mapRowToPost(row: unknown): PostData {
    const r = row as {
      id: string;
      author: string;
      createdAt: number;
      updatedAt: number;
      signature: string;
      version: string;
      text: string;
      contentHash: string;
      mediaAttachments?: string | PostData['mediaAttachments'] | null;
      replyTo: string | null;
      deleted: number | boolean;
      revision?: number | null;
      previousRevisionHash?: string | null;
    };
    return {
      id: r.id,
      author: r.author,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      signature: r.signature,
      version: r.version,
      text: r.text,
      contentHash: r.contentHash,
      mediaAttachments: parseMediaAttachments(r.mediaAttachments),
      replyTo: r.replyTo || undefined,
      deleted: r.deleted === true || r.deleted === 1,
      revision: r.revision ?? undefined,
      previousRevisionHash: r.previousRevisionHash ?? undefined,
    };
  }
}

function parseMediaAttachments(
  value: string | PostData['mediaAttachments'] | null | undefined,
): PostData['mediaAttachments'] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!value) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as PostData['mediaAttachments']) : [];
  } catch {
    return [];
  }
}
