import { DatabaseService } from '../database/DatabaseService';
import type { FollowData } from '../models/Follow';

/**
 * Follow repository for local SQLite storage
 */
export class FollowRepository {
  private db: DatabaseService;
  private tableName = 'follows';
  private initialized: Promise<void>;

  constructor(db: DatabaseService) {
    this.db = db;
    this.initialized = this.initializeTable();
  }

  /**
   * Initialize follows table
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
        followerId TEXT NOT NULL,
        followingId TEXT NOT NULL,
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
      CREATE INDEX IF NOT EXISTS idx_follows_followerId ON ${this.tableName}(followerId);
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_follows_followingId ON ${this.tableName}(followingId);
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_follows_deleted ON ${this.tableName}(deleted);
    `);

    // Unique constraint to prevent duplicate follows
    await this.db.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_follows_unique ON ${this.tableName}(followerId, followingId) WHERE deleted = 0;
    `);
  }

  /**
   * Create a new follow relationship
   */
  async create(follow: FollowData): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      INSERT OR REPLACE INTO ${this.tableName}
      (id, author, createdAt, updatedAt, signature, version, followerId, followingId, deleted, revision, previousRevisionHash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
      [
        follow.id,
        follow.author,
        follow.createdAt,
        follow.updatedAt,
        follow.signature,
        follow.version,
        follow.followerId,
        follow.followingId,
        follow.deleted ? 1 : 0,
        follow.revision ?? null,
        follow.previousRevisionHash ?? null,
      ],
    );
  }

  /**
   * Get a follow by ID
   */
  async getById(id: string): Promise<FollowData | null> {
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

    return this.mapRowToFollow(result[0]);
  }

  /**
   * Get follow relationship between two peers
   */
  async getByPeers(followerId: string, followingId: string): Promise<FollowData | null> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      WHERE followerId = ? AND followingId = ? AND deleted = 0;
    `,
      [followerId, followingId],
    );

    if (result.length === 0) {
      return null;
    }

    return this.mapRowToFollow(result[0]);
  }

  /**
   * Get followers of a peer
   */
  async getFollowers(
    followingId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<FollowData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      WHERE followingId = ? AND deleted = 0
      ORDER BY createdAt DESC
      LIMIT ? OFFSET ?;
    `,
      [followingId, limit, offset],
    );

    return result.map((row) => this.mapRowToFollow(row));
  }

  /**
   * Get following of a peer
   */
  async getFollowing(
    followerId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<FollowData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      WHERE followerId = ? AND deleted = 0
      ORDER BY createdAt DESC
      LIMIT ? OFFSET ?;
    `,
      [followerId, limit, offset],
    );

    return result.map((row) => this.mapRowToFollow(row));
  }

  async getAll(limit: number = 50, offset: number = 0): Promise<FollowData[]> {
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

    return result.map((row) => this.mapRowToFollow(row));
  }

  async getAllIncludingDeleted(limit: number = 1000, offset: number = 0): Promise<FollowData[]> {
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
    return result.map((row) => this.mapRowToFollow(row));
  }

  async getAllForSync(): Promise<FollowData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(`
      SELECT * FROM ${this.tableName}
      WHERE deleted IN (0, 1)
      ORDER BY updatedAt ASC;
    `);
    return result.map((row) => this.mapRowToFollow(row));
  }

  /**
   * Update a follow relationship
   */
  async update(follow: FollowData): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      UPDATE ${this.tableName}
      SET updatedAt = ?, signature = ?, version = ?, deleted = ?, revision = ?, previousRevisionHash = ?
      WHERE id = ?;
    `,
      [
        follow.updatedAt,
        follow.signature,
        follow.version,
        follow.deleted ? 1 : 0,
        follow.revision ?? null,
        follow.previousRevisionHash ?? null,
        follow.id,
      ],
    );
  }

  /**
   * Unfollow (soft delete)
   */
  async unfollow(followerId: string, followingId: string): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      UPDATE ${this.tableName}
      SET deleted = 1, updatedAt = ?
      WHERE followerId = ? AND followingId = ?;
    `,
      [Date.now(), followerId, followingId],
    );
  }

  /**
   * Delete a follow permanently
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
   * Get follower count
   */
  async getFollowerCount(followingId: string): Promise<number> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT COUNT(*) as count FROM ${this.tableName}
      WHERE followingId = ? AND deleted = 0;
    `,
      [followingId],
    );
    return (result[0] as { count: number }).count;
  }

  /**
   * Get following count
   */
  async getFollowingCount(followerId: string): Promise<number> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT COUNT(*) as count FROM ${this.tableName}
      WHERE followerId = ? AND deleted = 0;
    `,
      [followerId],
    );
    return (result[0] as { count: number }).count;
  }

  async getCount(): Promise<number> {
    await this.ensureInitialized();
    const result = await this.db.query(`
      SELECT COUNT(*) as count FROM ${this.tableName} WHERE deleted = 0;
    `);
    return (result[0] as { count: number }).count;
  }

  /**
   * Check if following
   */
  async isFollowing(followerId: string, followingId: string): Promise<boolean> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT COUNT(*) as count FROM ${this.tableName}
      WHERE followerId = ? AND followingId = ? AND deleted = 0;
    `,
      [followerId, followingId],
    );
    return (result[0] as { count: number }).count > 0;
  }

  /**
   * Map database row to FollowData
   */
  private mapRowToFollow(row: unknown): FollowData {
    const r = row as {
      id: string;
      author: string;
      createdAt: number;
      updatedAt: number;
      signature: string;
      version: string;
      followerId: string;
      followingId: string;
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
      followerId: r.followerId,
      followingId: r.followingId,
      deleted: r.deleted === 1,
      revision: r.revision ?? undefined,
      previousRevisionHash: r.previousRevisionHash ?? undefined,
    };
  }

  private async ensureInitialized(): Promise<void> {
    await this.initialized;
  }
}
