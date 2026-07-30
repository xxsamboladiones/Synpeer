import { DatabaseService } from '../../database/DatabaseService';
import type { Wallet, Transaction } from '../RewardTypes';

/**
 * Wallet Repository handles wallet persistence in SQLite
 */
export class WalletRepository {
  private db: DatabaseService;
  private walletsTableName = 'wallets';
  private transactionsTableName = 'transactions';

  constructor(db: DatabaseService) {
    this.db = db;
    this.initializeTables();
  }

  /**
   * Initialize database tables
   */
  private async initializeTables(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS ${this.walletsTableName} (
        address TEXT PRIMARY KEY,
        peerId TEXT NOT NULL,
        balance REAL NOT NULL DEFAULT 0,
        nonce INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);

    await this.db.run(`
      CREATE TABLE IF NOT EXISTS ${this.transactionsTableName} (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        fromAddress TEXT NOT NULL,
        toAddress TEXT NOT NULL,
        amount REAL NOT NULL,
        fee REAL NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL,
        status TEXT NOT NULL,
        category TEXT,
        description TEXT,
        metadata TEXT,
        walletAddress TEXT NOT NULL,
        FOREIGN KEY (walletAddress) REFERENCES ${this.walletsTableName}(address)
      );
    `);

    // Create indexes
    await this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_transactions_wallet
      ON ${this.transactionsTableName}(walletAddress);
    `);

    await this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_transactions_timestamp
      ON ${this.transactionsTableName}(timestamp);
    `);

    await this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_transactions_status
      ON ${this.transactionsTableName}(status);
    `);
  }

  /**
   * Save wallet
   */
  async saveWallet(wallet: Wallet): Promise<void> {
    await this.db.run(
      `
      INSERT OR REPLACE INTO ${this.walletsTableName}
      (address, peerId, balance, nonce, version, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?);
    `,
      [
        wallet.address,
        wallet.peerId,
        wallet.balance,
        wallet.nonce,
        wallet.version,
        wallet.createdAt,
        wallet.updatedAt,
      ],
    );
  }

  /**
   * Get wallet by address
   */
  async getWallet(address: string): Promise<Wallet | null> {
    const result = await this.db.query(
      `SELECTROW * FROM ${this.walletsTableName} WHERE address = ?;`,
      [address],
    );

    if (!result) {
      return null;
    }

    return this.mapRowToWallet(result as unknown as Record<string, unknown>);
  }

  /**
   * Get wallet by peer ID
   */
  async getWalletByPeerId(peerId: string): Promise<Wallet | null> {
    const result = await this.db.query(
      `SELECTROW * FROM ${this.walletsTableName} WHERE peerId = ?;`,
      [peerId],
    );

    if (!result) {
      return null;
    }

    return this.mapRowToWallet(result as unknown as Record<string, unknown>);
  }

  /**
   * Get all wallets
   */
  async getAllWallets(): Promise<Wallet[]> {
    const results = await this.db.query(`SELECT * FROM ${this.walletsTableName};`);
    return results.map((row) => this.mapRowToWallet(row as Record<string, unknown>));
  }

  /**
   * Delete wallet
   */
  async deleteWallet(address: string): Promise<void> {
    await this.db.run(`DELETE FROM ${this.walletsTableName} WHERE address = ?;`, [address]);
  }

  /**
   * Save transaction
   */
  async saveTransaction(transaction: Transaction, walletAddress: string): Promise<void> {
    await this.db.run(
      `
      INSERT OR REPLACE INTO ${this.transactionsTableName}
      (id, type, fromAddress, toAddress, amount, fee, timestamp, status, category, description, metadata, walletAddress)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
      [
        transaction.id,
        transaction.type,
        transaction.from,
        transaction.to,
        transaction.amount,
        transaction.fee,
        transaction.timestamp,
        transaction.status,
        transaction.category || null,
        transaction.description || null,
        transaction.metadata ? JSON.stringify(transaction.metadata) : null,
        walletAddress,
      ],
    );
  }

  /**
   * Get transaction by ID
   */
  async getTransaction(id: string): Promise<Transaction | null> {
    const result = await this.db.query(
      `SELECTROW * FROM ${this.transactionsTableName} WHERE id = ?;`,
      [id],
    );

    if (!result) {
      return null;
    }

    return this.mapRowToTransaction(result as unknown as Record<string, unknown>);
  }

  /**
   * Get transactions for wallet
   */
  async getTransactionsForWallet(
    walletAddress: string,
    limit?: number,
    offset?: number,
  ): Promise<Transaction[]> {
    let query = `SELECT * FROM ${this.transactionsTableName} WHERE walletAddress = ? ORDER BY timestamp DESC`;
    const params: (string | number)[] = [walletAddress];

    if (limit !== undefined) {
      query += ` LIMIT ?`;
      params.push(limit);
    }

    if (offset !== undefined) {
      query += ` OFFSET ?`;
      params.push(offset);
    }

    const results = await this.db.query(query, params);
    return results.map((row) =>
      this.mapRowToTransaction(row as unknown as Record<string, unknown>),
    );
  }

  /**
   * Get transactions by type
   */
  async getTransactionsByType(type: string, limit?: number): Promise<Transaction[]> {
    let query = `SELECT * FROM ${this.transactionsTableName} WHERE type = ? ORDER BY timestamp DESC`;
    const params: (string | number)[] = [type];

    if (limit !== undefined) {
      query += ` LIMIT ?`;
      params.push(limit);
    }

    const results = await this.db.query(query, params);
    return results.map((row) =>
      this.mapRowToTransaction(row as unknown as Record<string, unknown>),
    );
  }

  /**
   * Get transactions by status
   */
  async getTransactionsByStatus(status: string, limit?: number): Promise<Transaction[]> {
    let query = `SELECT * FROM ${this.transactionsTableName} WHERE status = ? ORDER BY timestamp DESC`;
    const params: (string | number)[] = [status];

    if (limit !== undefined) {
      query += ` LIMIT ?`;
      params.push(limit);
    }

    const results = await this.db.query(query, params);
    return results.map((row) =>
      this.mapRowToTransaction(row as unknown as Record<string, unknown>),
    );
  }

  /**
   * Delete transaction
   */
  async deleteTransaction(id: string): Promise<void> {
    await this.db.run(`DELETE FROM ${this.transactionsTableName} WHERE id = ?;`, [id]);
  }

  /**
   * Delete all transactions for wallet
   */
  async deleteTransactionsForWallet(walletAddress: string): Promise<void> {
    await this.db.run(`DELETE FROM ${this.transactionsTableName} WHERE walletAddress = ?;`, [
      walletAddress,
    ]);
  }

  /**
   * Map database row to Wallet
   */
  private mapRowToWallet(row: Record<string, unknown>): Wallet {
    return {
      address: row.address as string,
      peerId: row.peerId as string,
      balance: row.balance as number,
      nonce: row.nonce as number,
      version: row.version as number,
      createdAt: row.createdAt as number,
      updatedAt: row.updatedAt as number,
    };
  }

  /**
   * Map database row to Transaction
   */
  private mapRowToTransaction(row: Record<string, unknown>): Transaction {
    return {
      id: row.id as string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: row.type as any,
      from: row.fromAddress as string,
      to: row.toAddress as string,
      amount: row.amount as number,
      fee: row.fee as number,
      timestamp: row.timestamp as number,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      status: row.status as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      category: row.category as any,
      description: row.description as string | undefined,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    };
  }
}
