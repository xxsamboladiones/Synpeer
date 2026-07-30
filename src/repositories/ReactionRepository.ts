import { DatabaseService } from '../database/DatabaseService';
import type { ReactionData } from '../models/Reaction';

/**
 * Reaction repository for local SQLite storage
 */
export class ReactionRepository {
  private db: DatabaseService;
  private tableName = 'reactions';
  private initialized: Promise<void>;

  constructor(db: DatabaseService) {
    this.db = db;
    this.initialized = this.initializeTable();
  }

  /**
   * Initialize reactions table
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
        commentId TEXT,
        reactionType TEXT NOT NULL,
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
      CREATE INDEX IF NOT EXISTS idx_reactions_author ON ${this.tableName}(author);
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_reactions_postId ON ${this.tableName}(postId);
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_reactions_commentId ON ${this.tableName}(commentId);
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_reactions_deleted ON ${this.tableName}(deleted);
    `);

    // Unique constraint to prevent duplicate reactions
    await this.db.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reactions_unique ON ${this.tableName}(author, postId, commentId, reactionType) WHERE deleted = 0;
    `);
  }

  /**
   * Create a new reaction
   */
  async create(reaction: ReactionData): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      INSERT OR REPLACE INTO ${this.tableName}
      (id, author, createdAt, updatedAt, signature, version, postId, commentId, reactionType, deleted, revision, previousRevisionHash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
      [
        reaction.id,
        reaction.author,
        reaction.createdAt,
        reaction.updatedAt,
        reaction.signature,
        reaction.version,
        reaction.postId,
        reaction.commentId || null,
        reaction.reactionType,
        reaction.deleted ? 1 : 0,
        reaction.revision ?? null,
        reaction.previousRevisionHash ?? null,
      ],
    );
  }

  /**
   * Get a reaction by ID
   */
  async getById(id: string): Promise<ReactionData | null> {
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

    return this.mapRowToReaction(result[0]);
  }

  /**
   * Get reaction by author and target
   */
  async getByAuthorAndTarget(
    author: string,
    postId: string,
    commentId?: string,
  ): Promise<ReactionData | null> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      WHERE author = ? AND postId = ? AND (commentId = ? OR (commentId IS NULL AND ? IS NULL)) AND deleted = 0;
    `,
      [author, postId, commentId || null, commentId || null],
    );

    if (result.length === 0) {
      return null;
    }

    return this.mapRowToReaction(result[0]);
  }

  /**
   * Get reactions for a post
   */
  async getByPostId(
    postId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<ReactionData[]> {
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

    return result.map((row) => this.mapRowToReaction(row));
  }

  /**
   * Get reactions for a comment
   */
  async getByCommentId(
    commentId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<ReactionData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      WHERE commentId = ? AND deleted = 0
      ORDER BY createdAt DESC
      LIMIT ? OFFSET ?;
    `,
      [commentId, limit, offset],
    );

    return result.map((row) => this.mapRowToReaction(row));
  }

  /**
   * Get reactions by author
   */
  async getByAuthor(
    author: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<ReactionData[]> {
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

    return result.map((row) => this.mapRowToReaction(row));
  }

  /**
   * Update a reaction
   */
  async update(reaction: ReactionData): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      UPDATE ${this.tableName}
      SET updatedAt = ?, signature = ?, version = ?, deleted = ?, revision = ?, previousRevisionHash = ?
      WHERE id = ?;
    `,
      [
        reaction.updatedAt,
        reaction.signature,
        reaction.version,
        reaction.deleted ? 1 : 0,
        reaction.revision ?? null,
        reaction.previousRevisionHash ?? null,
        reaction.id,
      ],
    );
  }

  /**
   * Unreact (soft delete)
   */
  async unreact(author: string, postId: string, commentId?: string): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      UPDATE ${this.tableName}
      SET deleted = 1, updatedAt = ?
      WHERE author = ? AND postId = ? AND (commentId = ? OR (commentId IS NULL AND ? IS NULL));
    `,
      [Date.now(), author, postId, commentId || null, commentId || null],
    );
  }

  /**
   * Delete a reaction permanently
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
   * Get reaction count for a post
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

  /**
   * Get reaction count for a comment
   */
  async getCountByComment(commentId: string): Promise<number> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT COUNT(*) as count FROM ${this.tableName}
      WHERE commentId = ? AND deleted = 0;
    `,
      [commentId],
    );
    return (result[0] as { count: number }).count;
  }

  /**
   * Check if user has reacted to a post
   */
  async hasReacted(author: string, postId: string, commentId?: string): Promise<boolean> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT COUNT(*) as count FROM ${this.tableName}
      WHERE author = ? AND postId = ? AND (commentId = ? OR (commentId IS NULL AND ? IS NULL)) AND deleted = 0;
    `,
      [author, postId, commentId || null, commentId || null],
    );
    return (result[0] as { count: number }).count > 0;
  }

  async getAll(limit: number = 50, offset: number = 0): Promise<ReactionData[]> {
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

    return result.map((row) => this.mapRowToReaction(row));
  }

  async getAllIncludingDeleted(limit: number = 1000, offset: number = 0): Promise<ReactionData[]> {
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
    return result.map((row) => this.mapRowToReaction(row));
  }

  async getAllForSync(): Promise<ReactionData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(`
      SELECT * FROM ${this.tableName}
      WHERE deleted IN (0, 1)
      ORDER BY updatedAt ASC;
    `);
    return result.map((row) => this.mapRowToReaction(row));
  }

  async getCount(): Promise<number> {
    await this.ensureInitialized();
    const result = await this.db.query(`
      SELECT COUNT(*) as count FROM ${this.tableName} WHERE deleted = 0;
    `);
    return (result[0] as { count: number }).count;
  }

  /**
   * Map database row to ReactionData
   */
  private mapRowToReaction(row: unknown): ReactionData {
    const r = row as {
      id: string;
      author: string;
      createdAt: number;
      updatedAt: number;
      signature: string;
      version: string;
      postId: string;
      commentId: string | null;
      reactionType: string;
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
      commentId: r.commentId || undefined,
      reactionType: r.reactionType as 'like',
      deleted: r.deleted === 1,
      revision: r.revision ?? undefined,
      previousRevisionHash: r.previousRevisionHash ?? undefined,
    };
  }

  private async ensureInitialized(): Promise<void> {
    await this.initialized;
  }
}
