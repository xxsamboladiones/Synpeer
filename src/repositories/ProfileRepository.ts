import { DatabaseService } from '../database/DatabaseService';
import type { ProfileData } from '../models/Profile';

/**
 * Profile repository for local SQLite storage
 */
export class ProfileRepository {
  private db: DatabaseService;
  private tableName = 'profiles';
  private initialized: Promise<void>;

  constructor(db: DatabaseService) {
    this.db = db;
    this.initialized = this.initializeTable();
  }

  /**
   * Initialize profiles table
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
        username TEXT NOT NULL,
        displayName TEXT NOT NULL,
        bio TEXT,
        avatarHash TEXT,
        postCount INTEGER NOT NULL DEFAULT 0,
        followerCount INTEGER NOT NULL DEFAULT 0,
        followingCount INTEGER NOT NULL DEFAULT 0,
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
      CREATE INDEX IF NOT EXISTS idx_profiles_author ON ${this.tableName}(author);
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_profiles_username ON ${this.tableName}(username);
    `);
  }

  /**
   * Create a new profile
   */
  async create(profile: ProfileData): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      INSERT OR REPLACE INTO ${this.tableName}
      (id, author, createdAt, updatedAt, signature, version, username, displayName, bio, avatarHash, postCount, followerCount, followingCount, revision, previousRevisionHash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
      [
        profile.id,
        profile.author,
        profile.createdAt,
        profile.updatedAt,
        profile.signature,
        profile.version,
        profile.username,
        profile.displayName,
        profile.bio || null,
        profile.avatarHash || null,
        profile.postCount,
        profile.followerCount,
        profile.followingCount,
        profile.revision ?? null,
        profile.previousRevisionHash ?? null,
      ],
    );
  }

  /**
   * Get a profile by ID
   */
  async getById(id: string): Promise<ProfileData | null> {
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

    return this.mapRowToProfile(result[0]);
  }

  /**
   * Get a profile by author
   */
  async getByAuthor(author: string): Promise<ProfileData | null> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName} WHERE author = ?;
    `,
      [author],
    );

    if (result.length === 0) {
      return null;
    }

    return this.mapRowToProfile(result[0]);
  }

  /**
   * Get a profile by username
   */
  async getByUsername(username: string): Promise<ProfileData | null> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName} WHERE username = ?;
    `,
      [username],
    );

    if (result.length === 0) {
      return null;
    }

    return this.mapRowToProfile(result[0]);
  }

  /**
   * Get all profiles ordered by most recent update
   */
  async getAll(limit: number = 50, offset: number = 0): Promise<ProfileData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      ORDER BY updatedAt DESC
      LIMIT ? OFFSET ?;
    `,
      [limit, offset],
    );

    return result.map((row) => this.mapRowToProfile(row));
  }

  async getAllForSync(): Promise<ProfileData[]> {
    await this.ensureInitialized();
    const result = await this.db.query(`
      SELECT * FROM ${this.tableName}
      ORDER BY updatedAt ASC;
    `);
    return result.map((row) => this.mapRowToProfile(row));
  }

  /**
   * Update a profile
   */
  async update(profile: ProfileData): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      UPDATE ${this.tableName}
      SET updatedAt = ?, signature = ?, version = ?, username = ?, displayName = ?, bio = ?, avatarHash = ?, postCount = ?, followerCount = ?, followingCount = ?, revision = ?, previousRevisionHash = ?
      WHERE id = ?;
    `,
      [
        profile.updatedAt,
        profile.signature,
        profile.version,
        profile.username,
        profile.displayName,
        profile.bio || null,
        profile.avatarHash || null,
        profile.postCount,
        profile.followerCount,
        profile.followingCount,
        profile.revision ?? null,
        profile.previousRevisionHash ?? null,
        profile.id,
      ],
    );
  }

  /**
   * Increment post count
   */
  async incrementPostCount(author: string): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      UPDATE ${this.tableName}
      SET postCount = postCount + 1
      WHERE author = ?;
    `,
      [author],
    );
  }

  /**
   * Decrement post count
   */
  async decrementPostCount(author: string): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      UPDATE ${this.tableName}
      SET postCount = MAX(0, postCount - 1)
      WHERE author = ?;
    `,
      [author],
    );
  }

  /**
   * Increment follower count
   */
  async incrementFollowerCount(author: string): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      UPDATE ${this.tableName}
      SET followerCount = followerCount + 1
      WHERE author = ?;
    `,
      [author],
    );
  }

  /**
   * Decrement follower count
   */
  async decrementFollowerCount(author: string): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      UPDATE ${this.tableName}
      SET followerCount = MAX(0, followerCount - 1)
      WHERE author = ?;
    `,
      [author],
    );
  }

  /**
   * Increment following count
   */
  async incrementFollowingCount(author: string): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      UPDATE ${this.tableName}
      SET followingCount = followingCount + 1
      WHERE author = ?;
    `,
      [author],
    );
  }

  /**
   * Decrement following count
   */
  async decrementFollowingCount(author: string): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      UPDATE ${this.tableName}
      SET followingCount = MAX(0, followingCount - 1)
      WHERE author = ?;
    `,
      [author],
    );
  }

  /**
   * Get profile count
   */
  async getCount(): Promise<number> {
    await this.ensureInitialized();
    const result = await this.db.query(`
      SELECT COUNT(*) as count FROM ${this.tableName};
    `);
    return (result[0] as { count: number }).count;
  }

  /**
   * Map database row to ProfileData
   */
  private mapRowToProfile(row: unknown): ProfileData {
    const r = row as {
      id: string;
      author: string;
      createdAt: number;
      updatedAt: number;
      signature: string;
      version: string;
      username: string;
      displayName: string;
      bio: string | null;
      avatarHash: string | null;
      postCount: number;
      followerCount: number;
      followingCount: number;
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
      username: r.username,
      displayName: r.displayName,
      bio: r.bio || undefined,
      avatarHash: r.avatarHash || undefined,
      postCount: r.postCount,
      followerCount: r.followerCount,
      followingCount: r.followingCount,
      revision: r.revision ?? undefined,
      previousRevisionHash: r.previousRevisionHash ?? undefined,
    };
  }

  private async ensureInitialized(): Promise<void> {
    await this.initialized;
  }
}
