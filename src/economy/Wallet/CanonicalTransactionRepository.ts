import type { DatabaseService } from '@/database/DatabaseService';
import { AppError } from '@/errors/AppError';
import { createLogger } from '@/observability/Logger';

import type { CanonicalTransaction } from './TransactionModel';
import type { ReplayProtectorSnapshot } from './TransactionReplayProtector';

interface TransactionRow {
  id: string;
  senderId: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  data: string;
}

interface ReplaySnapshotRow {
  id: string;
  updatedAt: number;
  data: string;
}

export class CanonicalTransactionRepository {
  private readonly logger = createLogger('wallet.transaction.repository');

  constructor(private readonly database: DatabaseService) {}

  async initialize(): Promise<void> {
    await this.database.run(`
      CREATE TABLE IF NOT EXISTS canonical_transactions (
        id TEXT PRIMARY KEY,
        senderId TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    await this.database.run(`
      CREATE TABLE IF NOT EXISTS replay_snapshots (
        id TEXT PRIMARY KEY,
        updatedAt INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
  }

  async save(transaction: CanonicalTransaction, updatedAt = Date.now()): Promise<void> {
    await this.database.run(
      `
      INSERT OR REPLACE INTO canonical_transactions
      (id, senderId, status, createdAt, updatedAt, data)
      VALUES (?, ?, ?, ?, ?, ?);
    `,
      [
        transaction.id,
        transaction.senderId,
        transaction.status,
        transaction.createdAt,
        updatedAt,
        JSON.stringify(transaction),
      ],
    );
  }

  async getById(id: string): Promise<CanonicalTransaction | null> {
    const rows = await this.database.query('SELECT * FROM canonical_transactions WHERE id = ?;', [
      id,
    ]);
    const row = rows[0];
    if (!isTransactionRow(row)) {
      return null;
    }
    return this.parseTransaction(row);
  }

  async listBySender(senderId: string): Promise<CanonicalTransaction[]> {
    const rows = await this.database.query(
      'SELECT * FROM canonical_transactions WHERE senderId = ?;',
      [senderId],
    );
    return rows
      .filter(isTransactionRow)
      .map((row) => this.parseTransaction(row))
      .filter(isCanonicalTransaction);
  }

  async listAll(): Promise<CanonicalTransaction[]> {
    const rows = await this.database.query('SELECT * FROM canonical_transactions;');
    return rows
      .filter(isTransactionRow)
      .map((row) => this.parseTransaction(row))
      .filter(isCanonicalTransaction);
  }

  async saveReplaySnapshot(
    snapshot: ReplayProtectorSnapshot,
    updatedAt = Date.now(),
  ): Promise<void> {
    await this.database.run(
      `
      INSERT OR REPLACE INTO replay_snapshots
      (id, updatedAt, data)
      VALUES (?, ?, ?);
    `,
      ['transaction-replay', updatedAt, JSON.stringify(snapshot)],
    );
  }

  async loadReplaySnapshot(): Promise<ReplayProtectorSnapshot | null> {
    const rows = await this.database.query('SELECT * FROM replay_snapshots WHERE id = ?;', [
      'transaction-replay',
    ]);
    const row = rows[0];
    if (!isReplaySnapshotRow(row)) {
      return null;
    }

    try {
      const parsed = JSON.parse(row.data);
      return isReplaySnapshot(parsed) ? parsed : null;
    } catch (error) {
      this.logger.error('replay_snapshot_corrupt', error);
      return null;
    }
  }

  async reset(): Promise<void> {
    const transactions = await this.listAll();
    for (const transaction of transactions) {
      await this.database.run('DELETE FROM canonical_transactions WHERE id = ?;', [transaction.id]);
    }
    await this.database.run('DELETE FROM replay_snapshots WHERE id = ?;', ['transaction-replay']);
  }

  private parseTransaction(row: TransactionRow): CanonicalTransaction | null {
    try {
      const parsed = JSON.parse(row.data);
      return isCanonicalTransaction(parsed) ? parsed : null;
    } catch (error) {
      this.logger.error('transaction_record_corrupt', error, { transactionId: row.id });
      return null;
    }
  }
}

function isTransactionRow(value: unknown): value is TransactionRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    typeof row.senderId === 'string' &&
    typeof row.status === 'string' &&
    typeof row.createdAt === 'number' &&
    typeof row.updatedAt === 'number' &&
    typeof row.data === 'string'
  );
}

function isReplaySnapshotRow(value: unknown): value is ReplaySnapshotRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' && typeof row.updatedAt === 'number' && typeof row.data === 'string'
  );
}

function isCanonicalTransaction(value: unknown): value is CanonicalTransaction {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const transaction = value as Record<string, unknown>;
  return (
    typeof transaction.id === 'string' &&
    transaction.version === 1 &&
    typeof transaction.type === 'string' &&
    typeof transaction.senderId === 'string' &&
    typeof transaction.recipientId === 'string' &&
    typeof transaction.createdAt === 'number' &&
    typeof transaction.expiresAt === 'number' &&
    typeof transaction.nonce === 'string' &&
    typeof transaction.sequence === 'number' &&
    typeof transaction.payloadHash === 'string' &&
    typeof transaction.status === 'string' &&
    Array.isArray(transaction.history)
  );
}

function isReplaySnapshot(value: unknown): value is ReplayProtectorSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const snapshot = value as Record<string, unknown>;
  return (
    Array.isArray(snapshot.processedIds) &&
    Array.isArray(snapshot.nonceBySender) &&
    Array.isArray(snapshot.sequenceBySender)
  );
}

export function transactionPersistenceError(error: unknown): AppError {
  return new AppError({
    code: 'TRANSACTION_ERROR',
    message: error instanceof Error ? error.message : 'Transaction persistence failed',
    safeMessage: 'Nao foi possivel salvar a transacao local.',
    severity: 'error',
    retryable: true,
    cause: error,
    context: {
      scope: 'wallet.transaction.repository',
      operation: 'persist',
    },
  });
}
