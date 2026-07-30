import { DatabaseService } from '@/database/DatabaseService';
import type { ChatMessageData } from '@/models/ChatMessage';

export class ChatMessageRepository {
  private readonly tableName = 'chat_messages';
  private readonly initialized: Promise<void>;

  constructor(private readonly db: DatabaseService) {
    this.initialized = this.initializeTable();
  }

  private async initializeTable(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id TEXT PRIMARY KEY,
        author TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        signature TEXT NOT NULL,
        version TEXT NOT NULL,
        conversationId TEXT NOT NULL,
        senderId TEXT NOT NULL,
        recipientId TEXT NOT NULL,
        text TEXT NOT NULL,
        contentHash TEXT NOT NULL,
        deliveredAt INTEGER,
        readAt INTEGER,
        relayOnly INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        revision INTEGER,
        previousRevisionHash TEXT
      );
    `);

    await this.db
      .execute(
        `
      ALTER TABLE ${this.tableName} ADD COLUMN relayOnly INTEGER NOT NULL DEFAULT 0;
    `,
      )
      .catch(() => undefined);
    await this.db
      .execute(`ALTER TABLE ${this.tableName} ADD COLUMN revision INTEGER;`)
      .catch(() => undefined);
    await this.db
      .execute(`ALTER TABLE ${this.tableName} ADD COLUMN previousRevisionHash TEXT;`)
      .catch(() => undefined);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON ${this.tableName}(conversationId, createdAt);
    `);
    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_chat_messages_sender ON ${this.tableName}(senderId);
    `);
    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_chat_messages_recipient ON ${this.tableName}(recipientId);
    `);
    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_chat_messages_content_hash ON ${this.tableName}(contentHash);
    `);
    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_chat_messages_relay ON ${this.tableName}(relayOnly);
    `);
  }

  async create(message: ChatMessageData): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      INSERT OR REPLACE INTO ${this.tableName}
      (id, author, createdAt, updatedAt, signature, version, conversationId, senderId, recipientId, text, contentHash, deliveredAt, readAt, relayOnly, deleted, revision, previousRevisionHash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      [
        message.id,
        message.author,
        message.createdAt,
        message.updatedAt,
        message.signature,
        message.version,
        message.conversationId,
        message.senderId,
        message.recipientId,
        message.text,
        message.contentHash,
        message.deliveredAt ?? null,
        message.readAt ?? null,
        message.relayOnly ? 1 : 0,
        message.deleted ? 1 : 0,
        message.revision ?? null,
        message.previousRevisionHash ?? null,
      ],
    );
  }

  async update(message: ChatMessageData): Promise<void> {
    await this.ensureInitialized();
    await this.db.run(
      `
      UPDATE ${this.tableName}
      SET updatedAt = ?, signature = ?, version = ?, text = ?, deliveredAt = ?, readAt = ?, relayOnly = ?, deleted = ?, revision = ?, previousRevisionHash = ?
      WHERE id = ?;
      `,
      [
        message.updatedAt,
        message.signature,
        message.version,
        message.text,
        message.deliveredAt ?? null,
        message.readAt ?? null,
        message.relayOnly ? 1 : 0,
        message.deleted ? 1 : 0,
        message.revision ?? null,
        message.previousRevisionHash ?? null,
        message.id,
      ],
    );
  }

  async getById(id: string): Promise<ChatMessageData | null> {
    await this.ensureInitialized();
    const rows = await this.db.query(`SELECT * FROM ${this.tableName} WHERE id = ?;`, [id]);
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  async getByContentHash(contentHash: string): Promise<ChatMessageData[]> {
    await this.ensureInitialized();
    const rows = await this.db.query(`SELECT * FROM ${this.tableName} WHERE contentHash = ?;`, [
      contentHash,
    ]);
    return rows.map((row) => this.mapRow(row));
  }

  async getConversation(
    conversationId: string,
    limit = 100,
    offset = 0,
  ): Promise<ChatMessageData[]> {
    await this.ensureInitialized();
    const rows = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      WHERE conversationId = ? AND deleted = 0 AND relayOnly = 0
      ORDER BY createdAt ASC
      LIMIT ? OFFSET ?;
      `,
      [conversationId, limit, offset],
    );
    return rows.map((row) => this.mapRow(row));
  }

  async getAll(limit = 1000, offset = 0): Promise<ChatMessageData[]> {
    await this.ensureInitialized();
    const rows = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      WHERE deleted = 0
      ORDER BY updatedAt DESC
      LIMIT ? OFFSET ?;
      `,
      [limit, offset],
    );
    return rows.map((row) => this.mapRow(row));
  }

  async getAllIncludingDeleted(limit = 1000, offset = 0): Promise<ChatMessageData[]> {
    await this.ensureInitialized();
    const rows = await this.db.query(
      `
      SELECT * FROM ${this.tableName}
      WHERE deleted IN (0, 1)
      ORDER BY updatedAt ASC
      LIMIT ? OFFSET ?;
      `,
      [limit, offset],
    );
    return rows.map((row) => this.mapRow(row));
  }

  async getAllForSync(): Promise<ChatMessageData[]> {
    await this.ensureInitialized();
    const rows = await this.db.query(`
      SELECT * FROM ${this.tableName}
      WHERE deleted IN (0, 1)
      ORDER BY updatedAt ASC;
    `);
    return rows.map((row) => this.mapRow(row));
  }

  async getCount(): Promise<number> {
    await this.ensureInitialized();
    const result = await this.db.query(
      `SELECT COUNT(*) as count FROM ${this.tableName} WHERE deleted = 0 AND relayOnly = 0;`,
    );
    return (result[0] as { count: number }).count;
  }

  private mapRow(row: unknown): ChatMessageData {
    const value = row as {
      id: string;
      author: string;
      createdAt: number;
      updatedAt: number;
      signature: string;
      version: string;
      conversationId: string;
      senderId: string;
      recipientId: string;
      text: string;
      contentHash: string;
      deliveredAt: number | null;
      readAt: number | null;
      relayOnly?: number | boolean | null;
      deleted: number;
      revision?: number | null;
      previousRevisionHash?: string | null;
    };
    return {
      id: value.id,
      author: value.author,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      signature: value.signature,
      version: value.version,
      conversationId: value.conversationId,
      senderId: value.senderId,
      recipientId: value.recipientId,
      text: value.text,
      contentHash: value.contentHash,
      deliveredAt: value.deliveredAt ?? undefined,
      readAt: value.readAt ?? undefined,
      relayOnly: value.relayOnly === true || value.relayOnly === 1,
      deleted: value.deleted === 1,
      revision: value.revision ?? undefined,
      previousRevisionHash: value.previousRevisionHash ?? undefined,
    };
  }

  private async ensureInitialized(): Promise<void> {
    await this.initialized;
  }
}
