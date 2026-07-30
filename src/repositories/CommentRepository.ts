import { DatabaseService } from '../database/DatabaseService';
import type { CommentData } from '../models/Comment';

/**
 * Comment repository for local SQLite storage
 */
export class CommentRepository {
  private db: DatabaseService;
  private tableName = 'comments';
  private initialized: Promise<void>;

  constructor(db: DatabaseService) {
    this.db = db;
    this.initialized = this.initializeTable();
  }

  /**
   * Initialize comments table
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
        postId TEXT NOT NULL,
        text TEXT NOT NULL,
        contentHash TEXT NOT NULL,
        parentCommentId TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        revision INTEGER,
        previousRevisionHash TEXT
      );
    `);
    await this.db
      .execute(`ALTER TABLE ${this.tableName} ADD COLUMN revision INTEGER;`)
      .catch(() => undefined);
    await this.db
      .execute(`ALTER TABLE ${this.tableName} ADD COLUMN previousRevisionHash TEXT;`)
      .catch(() => undefined);

    // Create indexes for common queries
    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_comments_author ON ${this.tableName}(author);
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_comments_postId ON ${this.tableName}(postId);
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_comments_contentHash ON ${this.tableName}(contentHash);
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_comments_parentCommentId ON ${this.tableName}(parentCommentId);
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_comments_deleted ON ${this.tableName}(deleted);
    `);
  }

  /**
   * Create a new comment
   */
  async create(comment: CommentData): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      INSERT OR REPLACE INTO ${this.tableName}
      (id, author, createdAt, updatedAt, signature, version, postId, text, contentHash, parentCommentId, deleted, revision, previousRevisionHash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
      [
        comment.id,
        comment.author,
        comment.createdAt,
        comment.updatedAt,
        comment.signature,
        comment.version,
        comment.postId,
        comment.text,
        comment.contentHash,
        comment.parentCommentId || null,
        comment.deleted ? 1 : 0,
        comment.revision ?? null,
        comment.previousRevisionHash ?? null,
      ],
    );
  }

  /**
   * Get a comment by ID
   */
  async getById(id: string): Promise<CommentData | null> {
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

    return this.mapRowToComment(result[0]);
  }

  /**
   * Get comments by post
   */
  async getByPostId(
    postId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<CommentData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      WHERE postId = ? AND deleted = 0
      ORDER BY createdAt DESC
      LIMIT ? OFFSET ?;
    `,
      [postId, limit, offset],
    );

    return result.map((row) => this.mapRowToComment(row));
  }

  /**
   * Get comments by author
   */
  async getByAuthor(
    author: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<CommentData[]> {
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

    return result.map((row) => this.mapRowToComment(row));
  }

  /**
   * Get comments by content hash (for deduplication)
   */
  async getByContentHash(contentHash: string): Promise<CommentData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      WHERE contentHash = ?;
    `,
      [contentHash],
    );

    return result.map((row) => this.mapRowToComment(row));
  }

  /**
   * Get replies to a comment
   */
  async getReplies(
    parentCommentId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<CommentData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      WHERE parentCommentId = ? AND deleted = 0
      ORDER BY createdAt DESC
      LIMIT ? OFFSET ?;
    `,
      [parentCommentId, limit, offset],
    );

    return result.map((row) => this.mapRowToComment(row));
  }

  /**
   * Update a comment
   */
  async update(comment: CommentData): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      UPDATE ${this.tableName}
      SET updatedAt = ?, signature = ?, version = ?, text = ?, contentHash = ?, deleted = ?, revision = ?, previousRevisionHash = ?
      WHERE id = ?;
    `,
      [
        comment.updatedAt,
        comment.signature,
        comment.version,
        comment.text,
        comment.contentHash,
        comment.deleted ? 1 : 0,
        comment.revision ?? null,
        comment.previousRevisionHash ?? null,
        comment.id,
      ],
    );
  }

  /**
   * Soft delete a comment
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
   * Delete a comment permanently
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
   * Get comment count for a post
   */
  async getCountByPost(postId: string): Promise<number> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT COUNT(*) as count FROM ${this.tableName}
      WHERE postId = ? AND deleted = 0;
    `,
      [postId],
    );
    return (result[0] as { count: number }).count;
  }

  async getAll(limit: number = 50, offset: number = 0): Promise<CommentData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      WHERE deleted = 0
      ORDER BY updatedAt DESC
      LIMIT ? OFFSET ?;
    `,
      [limit, offset],
    );

    return result.map((row) => this.mapRowToComment(row));
  }

  async getAllIncludingDeleted(limit: number = 1000, offset: number = 0): Promise<CommentData[]> {
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
    return result.map((row) => this.mapRowToComment(row));
  }

  async getAllForSync(): Promise<CommentData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(`
      SELECT * FROM ${this.tableName}
      WHERE deleted IN (0, 1)
      ORDER BY updatedAt ASC;
    `);
    return result.map((row) => this.mapRowToComment(row));
  }

  async getCount(): Promise<number> {
    await this.ensureInitialized();
    const result = await this.db.query(`
      SELECT COUNT(*) as count FROM ${this.tableName} WHERE deleted = 0;
    `);
    return (result[0] as { count: number }).count;
  }

  /**
   * Map database row to CommentData
   */
  private mapRowToComment(row: unknown): CommentData {
    const r = row as {
      id: string;
      author: string;
      createdAt: number;
      updatedAt: number;
      signature: string;
      version: string;
      postId: string;
      text: string;
      contentHash: string;
      parentCommentId: string | null;
      deleted: number;
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
      postId: r.postId,
      text: r.text,
      contentHash: r.contentHash,
      parentCommentId: r.parentCommentId || undefined,
      deleted: r.deleted === 1,
      revision: r.revision ?? undefined,
      previousRevisionHash: r.previousRevisionHash ?? undefined,
    };
  }

  private async ensureInitialized(): Promise<void> {
    await this.initialized;
  }
}
