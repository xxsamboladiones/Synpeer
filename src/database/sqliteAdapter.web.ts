/* global IDBDatabase, IDBObjectStore, IDBRequest, IDBTransaction, IDBTransactionMode */
import { AppError, toAppError } from '@/errors/AppError';
import { createLogger } from '@/observability/Logger';

import {
  createDatabaseService,
  DATABASE_NAME,
  type DatabaseService,
  type SQLParameter,
} from './DatabaseService';

type Row = Record<string, SQLParameter | string | null>;
type TableName =
  | 'posts'
  | 'profiles'
  | 'follows'
  | 'comments'
  | 'reactions'
  | 'chat_messages'
  | 'media_objects'
  | 'media_chunks'
  | 'canonical_transactions'
  | 'replay_snapshots'
  | 'consensus_snapshots'
  | 'social_delivery_records'
  | 'social_conflict_decisions'
  | 'sync_checkpoints'
  | 'media_download_jobs'
  | 'media_availability_announcements'
  | 'media_replica_observations'
  | 'media_quarantine_records'
  | 'media_access_records';

export interface StorageCapabilities extends Record<string, string | number | boolean> {
  transactions: boolean;
  binaryData: boolean;
  indexes: boolean;
  persistenceGuaranteed: boolean;
  backend: 'indexeddb' | 'memory';
}

export interface WebDatabaseOptions {
  databaseName?: string;
  forceMemory?: boolean;
}

interface WebTableBackend {
  readonly capabilities: StorageCapabilities;
  ensureTable(tableName: TableName): Promise<void>;
  upsert(tableName: TableName, row: Row): Promise<void>;
  deleteById(tableName: TableName, id: string): Promise<void>;
  deleteWhere(tableName: TableName, predicate: (row: Row) => boolean): Promise<void>;
  getRows(tableName: TableName): Promise<Row[]>;
  withTransaction<T>(work: (backend: WebTableBackend) => Promise<T>): Promise<T>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

const logger = createLogger('storage.web');
const WEB_DATABASE_VERSION = 9;
const INDEXEDDB_BLOCKED_TIMEOUT_MS = 5000;
const TABLES: readonly TableName[] = [
  'posts',
  'profiles',
  'follows',
  'comments',
  'reactions',
  'chat_messages',
  'media_objects',
  'media_chunks',
  'canonical_transactions',
  'replay_snapshots',
  'consensus_snapshots',
  'social_delivery_records',
  'social_conflict_decisions',
  'sync_checkpoints',
  'media_download_jobs',
  'media_availability_announcements',
  'media_replica_observations',
  'media_quarantine_records',
  'media_access_records',
];

export async function openDatabaseService(
  options: WebDatabaseOptions = {},
): Promise<DatabaseService> {
  const backend = await openWebBackend(options);
  const createOperations = (target: WebTableBackend) => ({
    execAsync: async (statement: string) => {
      const createMatch = statement.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i);
      if (createMatch && isTableName(createMatch[1])) {
        await target.ensureTable(createMatch[1]);
      }
    },
    runAsync: async (statement: string, params: readonly SQLParameter[]) => {
      await runStatement(target, statement, params);
    },
    getAllAsync: async (statement: string, params: readonly SQLParameter[] = []) =>
      queryStatement(target, statement, params),
  });

  logger.info('database_opened', {
    backend: backend.capabilities.backend,
    persistenceGuaranteed: backend.capabilities.persistenceGuaranteed,
  });

  return createDatabaseService({
    ...createOperations(backend),
    withTransactionAsync: async (work) =>
      await backend.withTransaction(
        async (transactionBackend) => await work(createOperations(transactionBackend)),
      ),
    closeAsync: async () => {
      await backend.close();
    },
    resetAsync: async () => {
      await backend.reset();
    },
    capabilities: backend.capabilities,
  });
}

async function openWebBackend(options: WebDatabaseOptions): Promise<WebTableBackend> {
  if (!options.forceMemory && typeof globalThis.indexedDB !== 'undefined') {
    try {
      return await IndexedDbTableBackend.open(options.databaseName ?? DATABASE_NAME);
    } catch (error) {
      const appError = toAppError(error, {
        code: 'STORAGE_ERROR',
        message: 'Failed to open IndexedDB storage',
        safeMessage: 'Nao foi possivel abrir o armazenamento local.',
        severity: 'error',
        retryable: true,
        context: {
          scope: 'storage.web',
          operation: 'open',
        },
      });
      logger.error('indexeddb_open_failed', appError);
      throw appError;
    }
  }

  logger.warn('memory_storage_fallback_selected', {
    persistenceGuaranteed: false,
  });
  return new MemoryTableBackend();
}

class MemoryTableBackend implements WebTableBackend {
  readonly capabilities: StorageCapabilities = {
    transactions: true,
    binaryData: true,
    indexes: false,
    persistenceGuaranteed: false,
    backend: 'memory',
  };

  private tables: Map<TableName, Map<string, Row>>;
  private closed = false;
  private transactionQueue: Promise<void> = Promise.resolve();

  constructor(tables: Map<TableName, Map<string, Row>> = new Map()) {
    this.tables = tables;
  }

  async ensureTable(tableName: TableName): Promise<void> {
    this.assertOpen();
    if (!this.tables.has(tableName)) {
      this.tables.set(tableName, new Map());
    }
  }

  async upsert(tableName: TableName, row: Row): Promise<void> {
    this.assertOpen();
    await this.ensureTable(tableName);
    this.tables.get(tableName)?.set(String(row.id), row);
  }

  async deleteById(tableName: TableName, id: string): Promise<void> {
    this.assertOpen();
    await this.ensureTable(tableName);
    this.tables.get(tableName)?.delete(id);
  }

  async deleteWhere(tableName: TableName, predicate: (row: Row) => boolean): Promise<void> {
    this.assertOpen();
    await this.ensureTable(tableName);
    const table = this.tables.get(tableName);
    if (!table) {
      return;
    }

    for (const [id, row] of table.entries()) {
      if (predicate(row)) {
        table.delete(id);
      }
    }
  }

  async getRows(tableName: TableName): Promise<Row[]> {
    this.assertOpen();
    await this.ensureTable(tableName);
    return [...(this.tables.get(tableName)?.values() ?? [])];
  }

  async withTransaction<T>(work: (backend: WebTableBackend) => Promise<T>): Promise<T> {
    this.assertOpen();
    const operation = this.transactionQueue.then(async () => {
      const transactionBackend = new MemoryTableBackend(cloneTables(this.tables));
      const result = await work(transactionBackend);
      this.tables = cloneTables(transactionBackend.tables);
      return result;
    });
    this.transactionQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  async reset(): Promise<void> {
    this.assertOpen();
    this.tables.clear();
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AppError({
        code: 'STORAGE_ERROR',
        message: 'Storage backend is closed',
        safeMessage: 'O armazenamento local esta fechado.',
        severity: 'error',
        retryable: false,
        context: {
          scope: 'storage.web',
          operation: 'assert-open',
        },
      });
    }
  }
}

class IndexedDbTableBackend implements WebTableBackend {
  readonly capabilities: StorageCapabilities = {
    transactions: true,
    binaryData: true,
    indexes: true,
    persistenceGuaranteed: true,
    backend: 'indexeddb',
  };

  private constructor(
    private readonly database: IDBDatabase,
    private readonly activeTransaction: IDBTransaction | null = null,
  ) {}

  static async open(databaseName: string): Promise<IndexedDbTableBackend> {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = globalThis.indexedDB.open(databaseName, WEB_DATABASE_VERSION);
      let blockedTimeout: ReturnType<typeof globalThis.setTimeout> | null = null;

      const clearBlockedTimeout = () => {
        if (blockedTimeout) {
          globalThis.clearTimeout(blockedTimeout);
          blockedTimeout = null;
        }
      };

      request.onupgradeneeded = () => {
        const db = request.result;
        const upgradeTransaction = request.transaction;
        if (!upgradeTransaction) {
          throw new Error('IndexedDB upgrade transaction is unavailable');
        }
        for (const table of TABLES) {
          let store: IDBObjectStore;
          if (!db.objectStoreNames.contains(table)) {
            store = db.createObjectStore(table, { keyPath: 'id' });
          } else {
            store = upgradeTransaction.objectStore(table);
          }
          if (table === 'social_delivery_records') {
            ensureIndex(store, 'kind', 'kind');
            ensureIndex(store, 'status', 'status');
            ensureIndex(store, 'nextAttemptAt', 'nextAttemptAt');
            ensureIndex(store, 'expiresAt', 'expiresAt');
            ensureIndex(store, 'messageId', 'messageId');
          }
          if (table === 'sync_checkpoints') {
            ensureIndex(store, 'peerId', 'peerId');
            ensureIndex(store, 'entity', 'entity');
            ensureIndex(store, 'status', 'status');
          }
          if (table === 'social_conflict_decisions') {
            ensureIndex(store, 'entity', 'entity');
            ensureIndex(store, 'entityId', 'entityId');
            ensureIndex(store, 'decidedAt', 'decidedAt');
          }
          if (table === 'media_download_jobs') {
            ensureIndex(store, 'status', 'status');
            ensureIndex(store, 'updatedAt', 'updatedAt');
          }
          if (table === 'media_availability_announcements') {
            ensureIndex(store, 'peerId', 'peerId');
            ensureIndex(store, 'updatedAt', 'updatedAt');
          }
          if (table === 'media_replica_observations') {
            ensureIndex(store, 'peerId', 'peerId');
            ensureIndex(store, 'mediaObjectId', 'mediaObjectId');
            ensureIndex(store, 'updatedAt', 'updatedAt');
          }
          if (table === 'media_quarantine_records') {
            ensureIndex(store, 'peerId', 'peerId');
            ensureIndex(store, 'expiresAt', 'expiresAt');
          }
          if (table === 'media_access_records') {
            ensureIndex(store, 'lastAccessedAt', 'lastAccessedAt');
          }
        }
      };
      request.onsuccess = () => {
        clearBlockedTimeout();
        const database = request.result;
        database.onversionchange = () => {
          logger.warn('indexeddb_versionchange_close_requested', {
            databaseName,
          });
          database.close();
        };
        resolve(database);
      };
      request.onerror = () => {
        clearBlockedTimeout();
        reject(request.error ?? new Error('IndexedDB open failed'));
      };
      request.onblocked = () => {
        logger.warn('indexeddb_open_blocked_waiting_for_old_connection', {
          databaseName,
          version: WEB_DATABASE_VERSION,
        });
        blockedTimeout = globalThis.setTimeout(() => {
          reject(
            new AppError({
              code: 'STORAGE_ERROR',
              message: 'IndexedDB open blocked by an old connection',
              safeMessage:
                'O banco local esta bloqueado por outra aba do app. Feche outras abas e recarregue.',
              severity: 'error',
              retryable: true,
              context: {
                scope: 'storage.web',
                operation: 'open',
                databaseName,
                version: WEB_DATABASE_VERSION,
              },
            }),
          );
        }, INDEXEDDB_BLOCKED_TIMEOUT_MS);
      };
    });

    return new IndexedDbTableBackend(database);
  }

  async ensureTable(tableName: TableName): Promise<void> {
    this.assertOpen();
    if (!this.database.objectStoreNames.contains(tableName)) {
      throw new AppError({
        code: 'STORAGE_ERROR',
        message: `Object store ${tableName} is missing`,
        safeMessage: 'O schema local esta incompleto.',
        severity: 'critical',
        retryable: false,
        context: {
          scope: 'storage.web',
          operation: 'ensure-table',
          tableName,
        },
      });
    }
  }

  async upsert(tableName: TableName, row: Row): Promise<void> {
    await this.ensureTable(tableName);
    await this.write(tableName, 'readwrite', (store) => store.put(row));
  }

  async deleteById(tableName: TableName, id: string): Promise<void> {
    await this.ensureTable(tableName);
    await this.write(tableName, 'readwrite', (store) => store.delete(id));
  }

  async deleteWhere(tableName: TableName, predicate: (row: Row) => boolean): Promise<void> {
    const rows = await this.getRows(tableName);
    await this.transaction(tableName, 'readwrite', async (store) => {
      for (const row of rows) {
        if (predicate(row)) {
          store.delete(String(row.id));
        }
      }
    });
  }

  async getRows(tableName: TableName): Promise<Row[]> {
    await this.ensureTable(tableName);
    return await this.readAll(tableName);
  }

  async withTransaction<T>(work: (backend: WebTableBackend) => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.activeTransaction) {
      return await work(this);
    }
    const transaction = this.database.transaction([...TABLES], 'readwrite');
    const completion = transactionToPromise(transaction);
    const transactionBackend = new IndexedDbTableBackend(this.database, transaction);
    try {
      const result = await work(transactionBackend);
      await completion;
      return result;
    } catch (error) {
      try {
        transaction.abort();
      } catch (abortError) {
        logger.debug('indexeddb_transaction_abort_skipped', {
          message:
            abortError instanceof Error ? abortError.message : 'transaction-already-finished',
        });
      }
      await completion.catch(() => undefined);
      throw error;
    }
  }

  async reset(): Promise<void> {
    for (const table of TABLES) {
      await this.ensureTable(table);
      await this.write(table, 'readwrite', (store) => store.clear());
    }
  }

  async close(): Promise<void> {
    this.database.close();
  }

  private async readAll(tableName: TableName): Promise<Row[]> {
    return await this.transaction(tableName, 'readonly', async (store) => {
      const rows = await requestToPromise<unknown[]>(store.getAll());
      return rows.filter(isRow);
    });
  }

  private async write<T>(
    tableName: TableName,
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<void> {
    await this.transaction(tableName, mode, async (store) => {
      await requestToPromise(operation(store));
    });
  }

  private async transaction<T>(
    tableName: TableName,
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    this.assertOpen();
    if (this.activeTransaction) {
      return await work(this.activeTransaction.objectStore(tableName));
    }
    const transaction = this.database.transaction(tableName, mode);
    const store = transaction.objectStore(tableName);
    const result = await work(store);
    await transactionToPromise(transaction);
    return result;
  }

  private assertOpen(): void {
    if (!this.database.objectStoreNames) {
      throw new AppError({
        code: 'STORAGE_ERROR',
        message: 'IndexedDB connection is closed',
        safeMessage: 'O armazenamento local esta fechado.',
        severity: 'error',
        retryable: true,
        context: {
          scope: 'storage.web',
          operation: 'assert-open',
        },
      });
    }
  }
}

async function runStatement(
  backend: WebTableBackend,
  statement: string,
  params: readonly SQLParameter[],
): Promise<void> {
  const normalized = normalize(statement);
  if (normalized.startsWith('INSERT OR REPLACE INTO posts')) {
    await backend.upsert('posts', mapPost(params));
    return;
  }
  if (normalized.startsWith('UPDATE posts SET deleted = 1')) {
    await updatePostRow(backend, String(params[1]), {
      deleted: 1,
      updatedAt: params[0],
    });
    return;
  }
  if (normalized.startsWith('UPDATE posts SET')) {
    const hasRevisionMetadata = params.length >= 10;
    await updatePostRow(backend, String(params[hasRevisionMetadata ? 9 : 7]), {
      updatedAt: params[0],
      signature: params[1],
      version: params[2],
      text: params[3],
      contentHash: params[4],
      mediaAttachments: params[5],
      deleted: params[6],
      ...(hasRevisionMetadata ? { revision: params[7], previousRevisionHash: params[8] } : {}),
    });
    return;
  }
  if (normalized.startsWith('DELETE FROM posts')) {
    await backend.deleteById('posts', String(params[0]));
    return;
  }
  if (normalized.startsWith('INSERT OR REPLACE INTO profiles')) {
    await backend.upsert('profiles', mapProfile(params));
    return;
  }
  if (normalized.startsWith('UPDATE profiles SET postCount')) {
    const updatesTimestamp = params.length > 1;
    await incrementProfileCount(
      backend,
      String(params[updatesTimestamp ? 1 : 0]),
      'postCount',
      normalized,
      updatesTimestamp ? params[0] : undefined,
    );
    return;
  }
  if (normalized.startsWith('UPDATE profiles SET followerCount')) {
    const updatesTimestamp = params.length > 1;
    await incrementProfileCount(
      backend,
      String(params[updatesTimestamp ? 1 : 0]),
      'followerCount',
      normalized,
      updatesTimestamp ? params[0] : undefined,
    );
    return;
  }
  if (normalized.startsWith('UPDATE profiles SET followingCount')) {
    const updatesTimestamp = params.length > 1;
    await incrementProfileCount(
      backend,
      String(params[updatesTimestamp ? 1 : 0]),
      'followingCount',
      normalized,
      updatesTimestamp ? params[0] : undefined,
    );
    return;
  }
  if (normalized.startsWith('UPDATE profiles SET')) {
    const hasRevisionMetadata = params.length >= 13;
    await updateRow(backend, 'profiles', String(params[hasRevisionMetadata ? 12 : 10]), {
      updatedAt: params[0],
      signature: params[1],
      version: params[2],
      username: params[3],
      displayName: params[4],
      bio: params[5],
      avatarHash: params[6],
      postCount: params[7],
      followerCount: params[8],
      followingCount: params[9],
      ...(hasRevisionMetadata ? { revision: params[10], previousRevisionHash: params[11] } : {}),
    });
    return;
  }
  if (normalized.startsWith('INSERT OR REPLACE INTO follows')) {
    await backend.upsert('follows', mapFollow(params));
    return;
  }
  if (normalized.startsWith('UPDATE follows SET deleted = 1')) {
    await updateFollowByPeers(backend, String(params[1]), String(params[2]), {
      deleted: 1,
      updatedAt: params[0],
    });
    return;
  }
  if (normalized.startsWith('UPDATE follows SET')) {
    const hasRevisionMetadata = params.length >= 7;
    await updateRow(backend, 'follows', String(params[hasRevisionMetadata ? 6 : 4]), {
      updatedAt: params[0],
      signature: params[1],
      version: params[2],
      deleted: params[3],
      ...(hasRevisionMetadata ? { revision: params[4], previousRevisionHash: params[5] } : {}),
    });
    return;
  }
  if (normalized.startsWith('DELETE FROM follows')) {
    await backend.deleteById('follows', String(params[0]));
    return;
  }
  if (normalized.startsWith('INSERT OR REPLACE INTO comments')) {
    await backend.upsert('comments', mapComment(params));
    return;
  }
  if (normalized.startsWith('UPDATE comments SET deleted = 1')) {
    await updateRow(backend, 'comments', String(params[1]), {
      deleted: 1,
      updatedAt: params[0],
    });
    return;
  }
  if (normalized.startsWith('UPDATE comments SET')) {
    const hasRevisionMetadata = params.length >= 9;
    await updateRow(backend, 'comments', String(params[hasRevisionMetadata ? 8 : 6]), {
      updatedAt: params[0],
      signature: params[1],
      version: params[2],
      text: params[3],
      contentHash: params[4],
      deleted: params[5],
      ...(hasRevisionMetadata ? { revision: params[6], previousRevisionHash: params[7] } : {}),
    });
    return;
  }
  if (normalized.startsWith('DELETE FROM comments')) {
    await backend.deleteById('comments', String(params[0]));
    return;
  }
  if (normalized.startsWith('INSERT OR REPLACE INTO reactions')) {
    await backend.upsert('reactions', mapReaction(params));
    return;
  }
  if (normalized.startsWith('UPDATE reactions SET deleted = 1')) {
    await updateReactionByTarget(backend, String(params[1]), String(params[2]), params[3], {
      deleted: 1,
      updatedAt: params[0],
    });
    return;
  }
  if (normalized.startsWith('UPDATE reactions SET')) {
    const hasRevisionMetadata = params.length >= 7;
    await updateRow(backend, 'reactions', String(params[hasRevisionMetadata ? 6 : 4]), {
      updatedAt: params[0],
      signature: params[1],
      version: params[2],
      deleted: params[3],
      ...(hasRevisionMetadata ? { revision: params[4], previousRevisionHash: params[5] } : {}),
    });
    return;
  }
  if (normalized.startsWith('DELETE FROM reactions')) {
    await backend.deleteById('reactions', String(params[0]));
    return;
  }
  if (normalized.startsWith('INSERT OR REPLACE INTO chat_messages')) {
    await backend.upsert('chat_messages', mapChatMessage(params));
    return;
  }
  if (normalized.startsWith('UPDATE chat_messages SET')) {
    const hasRevisionMetadata = params.length >= 11;
    await updateRow(backend, 'chat_messages', String(params[hasRevisionMetadata ? 10 : 8]), {
      updatedAt: params[0],
      signature: params[1],
      version: params[2],
      text: params[3],
      deliveredAt: params[4],
      readAt: params[5],
      relayOnly: params[6],
      deleted: params[7],
      ...(hasRevisionMetadata ? { revision: params[8], previousRevisionHash: params[9] } : {}),
    });
    return;
  }
  if (normalized.startsWith('INSERT OR REPLACE INTO media_objects')) {
    await backend.upsert('media_objects', mapMediaObject(params));
    return;
  }
  if (normalized.startsWith('UPDATE media_objects SET')) {
    await updateRow(backend, 'media_objects', String(params[11]), {
      updatedAt: params[0],
      signature: params[1],
      version: params[2],
      type: params[3],
      mime: params[4],
      size: params[5],
      hash: params[6],
      chunks: params[7],
      thumbnail: params[8],
      duration: params[9],
      codec: params[10],
    });
    return;
  }
  if (normalized.startsWith('DELETE FROM media_objects')) {
    await backend.deleteById('media_objects', String(params[0]));
    return;
  }
  if (normalized.startsWith('INSERT OR REPLACE INTO media_chunks')) {
    await backend.upsert('media_chunks', mapMediaChunk(params));
    return;
  }
  if (normalized.startsWith('UPDATE media_chunks SET')) {
    await updateRow(backend, 'media_chunks', String(params[6]), {
      updatedAt: params[0],
      signature: params[1],
      version: params[2],
      size: params[3],
      hash: params[4],
      chunkData: params[5],
    });
    return;
  }
  if (normalized.startsWith('DELETE FROM media_chunks WHERE mediaObjectId')) {
    await backend.deleteWhere('media_chunks', (row) => row.mediaObjectId === params[0]);
    return;
  }
  if (normalized.startsWith('DELETE FROM media_chunks')) {
    await backend.deleteById('media_chunks', String(params[0]));
    return;
  }
  if (normalized.startsWith('INSERT OR REPLACE INTO canonical_transactions')) {
    await backend.upsert('canonical_transactions', mapCanonicalTransaction(params));
    return;
  }
  if (normalized.startsWith('DELETE FROM canonical_transactions')) {
    await backend.deleteById('canonical_transactions', String(params[0]));
    return;
  }
  if (normalized.startsWith('INSERT OR REPLACE INTO replay_snapshots')) {
    await backend.upsert('replay_snapshots', mapReplaySnapshot(params));
    return;
  }
  if (normalized.startsWith('DELETE FROM replay_snapshots')) {
    await backend.deleteById('replay_snapshots', String(params[0]));
    return;
  }
  if (normalized.startsWith('INSERT OR REPLACE INTO consensus_snapshots')) {
    await backend.upsert('consensus_snapshots', mapConsensusSnapshot(params));
    return;
  }
  if (normalized.startsWith('DELETE FROM consensus_snapshots')) {
    await backend.deleteById('consensus_snapshots', String(params[0]));
    return;
  }
  if (normalized.startsWith('INSERT OR REPLACE INTO social_delivery_records')) {
    await backend.upsert('social_delivery_records', mapSocialDeliveryRecord(params));
    return;
  }
  if (normalized.startsWith('DELETE FROM social_delivery_records WHERE kind')) {
    await backend.deleteWhere('social_delivery_records', (row) => row.kind === params[0]);
    return;
  }
  if (normalized.startsWith('DELETE FROM social_delivery_records')) {
    await backend.deleteById('social_delivery_records', String(params[0]));
    return;
  }
  if (normalized.startsWith('INSERT OR REPLACE INTO social_conflict_decisions')) {
    await backend.upsert('social_conflict_decisions', mapSocialConflictDecision(params));
    return;
  }
  if (normalized.startsWith('DELETE FROM social_conflict_decisions')) {
    if (params.length === 0) {
      await backend.deleteWhere('social_conflict_decisions', () => true);
    } else {
      await backend.deleteById('social_conflict_decisions', String(params[0]));
    }
    return;
  }
  if (normalized.startsWith('INSERT OR REPLACE INTO sync_checkpoints')) {
    await backend.upsert('sync_checkpoints', mapSyncCheckpoint(params));
    return;
  }
  if (normalized.startsWith('DELETE FROM sync_checkpoints WHERE peerId')) {
    await backend.deleteWhere('sync_checkpoints', (row) => row.peerId === params[0]);
    return;
  }
  if (normalized.startsWith('DELETE FROM sync_checkpoints')) {
    if (params.length === 0) {
      await backend.deleteWhere('sync_checkpoints', () => true);
    } else {
      await backend.deleteById('sync_checkpoints', String(params[0]));
    }
    return;
  }
  if (normalized.startsWith('INSERT OR REPLACE INTO media_download_jobs')) {
    await backend.upsert('media_download_jobs', mapMediaDownloadJob(params));
    return;
  }
  if (normalized.startsWith('DELETE FROM media_download_jobs')) {
    if (params.length === 0) {
      await backend.deleteWhere('media_download_jobs', () => true);
    } else {
      await backend.deleteById('media_download_jobs', String(params[0]));
    }
    return;
  }
  if (normalized.startsWith('INSERT OR REPLACE INTO media_availability_announcements')) {
    await backend.upsert(
      'media_availability_announcements',
      mapMediaAvailabilityAnnouncement(params),
    );
    return;
  }
  if (normalized.startsWith('DELETE FROM media_availability_announcements')) {
    if (params.length === 0) {
      await backend.deleteWhere('media_availability_announcements', () => true);
    } else {
      await backend.deleteById('media_availability_announcements', String(params[0]));
    }
    return;
  }
}

async function queryStatement(
  backend: WebTableBackend,
  statement: string,
  params: readonly SQLParameter[],
): Promise<readonly unknown[]> {
  const normalized = normalize(statement);
  if (normalized.includes('FROM posts')) {
    return queryPosts(await backend.getRows('posts'), normalized, params);
  }
  if (normalized.includes('FROM profiles')) {
    return queryProfiles(await backend.getRows('profiles'), normalized, params);
  }
  if (normalized.includes('FROM follows')) {
    return queryFollows(await backend.getRows('follows'), normalized, params);
  }
  if (normalized.includes('FROM comments')) {
    return queryComments(await backend.getRows('comments'), normalized, params);
  }
  if (normalized.includes('FROM reactions')) {
    return queryReactions(await backend.getRows('reactions'), normalized, params);
  }
  if (normalized.includes('FROM chat_messages')) {
    return queryChatMessages(await backend.getRows('chat_messages'), normalized, params);
  }
  if (normalized.includes('FROM media_objects')) {
    return queryMediaObjects(await backend.getRows('media_objects'), normalized, params);
  }
  if (normalized.includes('FROM media_chunks')) {
    return queryMediaChunks(await backend.getRows('media_chunks'), normalized, params);
  }
  if (normalized.includes('FROM canonical_transactions')) {
    return queryCanonicalTransactions(
      await backend.getRows('canonical_transactions'),
      normalized,
      params,
    );
  }
  if (normalized.includes('FROM replay_snapshots')) {
    return queryReplaySnapshots(await backend.getRows('replay_snapshots'), normalized, params);
  }
  if (normalized.includes('FROM consensus_snapshots')) {
    return queryConsensusSnapshots(
      await backend.getRows('consensus_snapshots'),
      normalized,
      params,
    );
  }
  if (normalized.includes('FROM social_delivery_records')) {
    return querySocialDeliveryRecords(
      await backend.getRows('social_delivery_records'),
      normalized,
      params,
    );
  }
  if (normalized.includes('FROM social_conflict_decisions')) {
    return querySocialConflictDecisions(
      await backend.getRows('social_conflict_decisions'),
      normalized,
      params,
    );
  }
  if (normalized.includes('FROM sync_checkpoints')) {
    return querySyncCheckpoints(await backend.getRows('sync_checkpoints'), normalized, params);
  }
  if (normalized.includes('FROM media_download_jobs')) {
    return queryMediaPersistenceRows(
      await backend.getRows('media_download_jobs'),
      normalized,
      params,
    );
  }
  if (normalized.includes('FROM media_availability_announcements')) {
    return queryMediaPersistenceRows(
      await backend.getRows('media_availability_announcements'),
      normalized,
      params,
    );
  }
  return [];
}

async function updatePostRow(backend: WebTableBackend, id: string, patch: Row): Promise<void> {
  await updateRow(backend, 'posts', id, patch);
}

async function updateFollowByPeers(
  backend: WebTableBackend,
  followerId: string,
  followingId: string,
  patch: Row,
): Promise<void> {
  const existing = (await backend.getRows('follows')).find(
    (row) => row.followerId === followerId && row.followingId === followingId,
  );
  if (!existing) {
    return;
  }
  await backend.upsert('follows', { ...existing, ...patch });
}

async function updateReactionByTarget(
  backend: WebTableBackend,
  author: string,
  postId: string,
  commentId: SQLParameter,
  patch: Row,
): Promise<void> {
  const existing = (await backend.getRows('reactions')).find(
    (row) =>
      row.author === author &&
      row.postId === postId &&
      (row.commentId === commentId || (!row.commentId && !commentId)),
  );
  if (!existing) {
    return;
  }
  await backend.upsert('reactions', { ...existing, ...patch });
}

async function incrementProfileCount(
  backend: WebTableBackend,
  author: string,
  field: 'postCount' | 'followerCount' | 'followingCount',
  statement: string,
  updatedAt?: SQLParameter,
): Promise<void> {
  const existing = (await backend.getRows('profiles')).find((row) => row.author === author);
  if (!existing) {
    return;
  }
  const delta = statement.includes('MAX(0') ? -1 : 1;
  const updatedProfile = {
    ...existing,
    [field]: Math.max(0, Number(existing[field] ?? 0) + delta),
  };
  if (updatedAt !== undefined) {
    updatedProfile.updatedAt = updatedAt;
  }
  await backend.upsert('profiles', updatedProfile);
}

async function updateRow(
  backend: WebTableBackend,
  tableName: TableName,
  id: string,
  patch: Row,
): Promise<void> {
  const existing = (await backend.getRows(tableName)).find((row) => row.id === id);
  if (!existing) {
    return;
  }
  await backend.upsert(tableName, { ...existing, ...patch });
}

function queryPosts(rows: Row[], statement: string, params: readonly SQLParameter[]): Row[] {
  if (statement.includes('COUNT(*) as count')) {
    const filtered = statement.includes('WHERE author =')
      ? rows.filter((row) => row.author === params[0] && row.deleted === 0)
      : rows.filter((row) => row.deleted === 0);
    return [{ count: filtered.length }];
  }
  if (statement.includes('WHERE id =')) {
    return rows.filter((row) => row.id === params[0]);
  }
  if (statement.includes('WHERE author =')) {
    return sortByCreatedAt(rows.filter((row) => row.author === params[0] && row.deleted === 0));
  }
  if (statement.includes('WHERE contentHash =')) {
    return rows.filter((row) => row.contentHash === params[0]);
  }
  if (statement.includes('WHERE replyTo =')) {
    return sortByCreatedAt(rows.filter((row) => row.replyTo === params[0] && row.deleted === 0));
  }
  if (statement.includes('deleted IN')) {
    return sortByUpdatedAt(rows);
  }
  return sortByCreatedAt(rows.filter((row) => row.deleted === 0));
}

function queryProfiles(rows: Row[], statement: string, params: readonly SQLParameter[]): Row[] {
  if (statement.includes('WHERE id =')) {
    return rows.filter((row) => row.id === params[0]);
  }
  if (statement.includes('WHERE author =')) {
    return rows.filter((row) => row.author === params[0]);
  }
  if (statement.includes('WHERE username =')) {
    return rows.filter((row) => row.username === params[0]);
  }
  return sortByCreatedAt(rows);
}

function queryFollows(rows: Row[], statement: string, params: readonly SQLParameter[]): Row[] {
  const activeRows = rows.filter((row) => row.deleted === 0);
  if (statement.includes('COUNT(*) as count')) {
    if (statement.includes('WHERE followingId =')) {
      return [{ count: activeRows.filter((row) => row.followingId === params[0]).length }];
    }
    if (statement.includes('WHERE followerId =')) {
      return [{ count: activeRows.filter((row) => row.followerId === params[0]).length }];
    }
    return [{ count: activeRows.length }];
  }
  if (statement.includes('WHERE id =')) {
    return rows.filter((row) => row.id === params[0]);
  }
  if (statement.includes('WHERE followerId = ? AND followingId =')) {
    return activeRows.filter(
      (row) => row.followerId === params[0] && row.followingId === params[1],
    );
  }
  if (statement.includes('WHERE followingId =')) {
    return sortByCreatedAt(activeRows.filter((row) => row.followingId === params[0]));
  }
  if (statement.includes('WHERE followerId =')) {
    return sortByCreatedAt(activeRows.filter((row) => row.followerId === params[0]));
  }
  if (statement.includes('deleted IN')) {
    return sortByUpdatedAt(rows);
  }
  return sortByCreatedAt(activeRows);
}

function queryComments(rows: Row[], statement: string, params: readonly SQLParameter[]): Row[] {
  const activeRows = rows.filter((row) => row.deleted === 0);
  if (statement.includes('COUNT(*) as count')) {
    const filtered = statement.includes('WHERE postId =')
      ? activeRows.filter((row) => row.postId === params[0])
      : activeRows;
    return [{ count: filtered.length }];
  }
  if (statement.includes('WHERE id =')) {
    return rows.filter((row) => row.id === params[0]);
  }
  if (statement.includes('WHERE postId =')) {
    return sortByCreatedAt(activeRows.filter((row) => row.postId === params[0]));
  }
  if (statement.includes('WHERE author =')) {
    return sortByCreatedAt(activeRows.filter((row) => row.author === params[0]));
  }
  if (statement.includes('WHERE contentHash =')) {
    return rows.filter((row) => row.contentHash === params[0]);
  }
  if (statement.includes('WHERE parentCommentId =')) {
    return sortByCreatedAt(activeRows.filter((row) => row.parentCommentId === params[0]));
  }
  if (statement.includes('deleted IN')) {
    return sortByUpdatedAt(rows);
  }
  return sortByUpdatedAt(activeRows);
}

function queryReactions(rows: Row[], statement: string, params: readonly SQLParameter[]): Row[] {
  const activeRows = rows.filter((row) => row.deleted === 0);
  if (statement.includes('COUNT(*) as count')) {
    if (statement.includes('WHERE author =')) {
      return [
        {
          count: activeRows.filter(
            (row) =>
              row.author === params[0] &&
              row.postId === params[1] &&
              (row.commentId === params[2] || (!row.commentId && !params[2])),
          ).length,
        },
      ];
    }
    if (statement.includes('WHERE postId =')) {
      return [{ count: activeRows.filter((row) => row.postId === params[0]).length }];
    }
    if (statement.includes('WHERE commentId =')) {
      return [{ count: activeRows.filter((row) => row.commentId === params[0]).length }];
    }
    return [{ count: activeRows.length }];
  }
  if (statement.includes('WHERE id =')) {
    return rows.filter((row) => row.id === params[0]);
  }
  if (statement.includes('WHERE author =')) {
    return activeRows.filter(
      (row) =>
        row.author === params[0] &&
        row.postId === params[1] &&
        (row.commentId === params[2] || (!row.commentId && !params[2])),
    );
  }
  if (statement.includes('WHERE postId =')) {
    return sortByCreatedAt(activeRows.filter((row) => row.postId === params[0]));
  }
  if (statement.includes('WHERE commentId =')) {
    return sortByCreatedAt(activeRows.filter((row) => row.commentId === params[0]));
  }
  if (statement.includes('deleted IN')) {
    return sortByUpdatedAt(rows);
  }
  return sortByUpdatedAt(activeRows);
}

function queryChatMessages(rows: Row[], statement: string, params: readonly SQLParameter[]): Row[] {
  const activeRows = rows.filter((row) => row.deleted === 0);
  const visibleRows = activeRows.filter((row) => row.relayOnly !== 1 && row.relayOnly !== true);
  if (statement.includes('COUNT(*) as count')) {
    return [{ count: visibleRows.length }];
  }
  if (statement.includes('WHERE id =')) {
    return rows.filter((row) => row.id === params[0]);
  }
  if (statement.includes('WHERE contentHash =')) {
    return rows.filter((row) => row.contentHash === params[0]);
  }
  if (statement.includes('WHERE conversationId =')) {
    return sortByCreatedAt(visibleRows.filter((row) => row.conversationId === params[0]));
  }
  if (statement.includes('deleted IN')) {
    return sortByUpdatedAt(rows);
  }
  return sortByUpdatedAt(activeRows);
}

function queryMediaObjects(rows: Row[], statement: string, params: readonly SQLParameter[]): Row[] {
  if (statement.includes('COUNT(*) as count')) {
    const filtered = statement.includes('WHERE author =')
      ? rows.filter((row) => row.author === params[0])
      : statement.includes('WHERE type =')
        ? rows.filter((row) => row.type === params[0])
        : rows;
    return [{ count: filtered.length }];
  }
  if (statement.includes('WHERE id =')) {
    return rows.filter((row) => row.id === params[0]);
  }
  if (statement.includes('WHERE author =')) {
    return sortByCreatedAt(rows.filter((row) => row.author === params[0]));
  }
  if (statement.includes('WHERE type =')) {
    return sortByCreatedAt(rows.filter((row) => row.type === params[0]));
  }
  if (statement.includes('WHERE hash =')) {
    return rows.filter((row) => row.hash === params[0]);
  }
  return sortByCreatedAt(rows);
}

function queryMediaChunks(rows: Row[], statement: string, params: readonly SQLParameter[]): Row[] {
  if (statement.includes('COUNT(*) as count')) {
    const filtered = statement.includes('WHERE mediaObjectId =')
      ? rows.filter((row) => row.mediaObjectId === params[0])
      : rows;
    return [{ count: filtered.length }];
  }
  if (statement.includes('SUM(size) as total')) {
    return [{ total: rows.reduce((sum, row) => sum + Number(row.size ?? 0), 0) }];
  }
  if (statement.includes('WHERE id =')) {
    return rows.filter((row) => row.id === params[0]);
  }
  if (statement.includes('WHERE mediaObjectId = ? AND position =')) {
    return rows.filter((row) => row.mediaObjectId === params[0] && row.position === params[1]);
  }
  if (statement.includes('WHERE mediaObjectId =')) {
    return rows
      .filter((row) => row.mediaObjectId === params[0])
      .sort((left, right) => Number(left.position) - Number(right.position));
  }
  if (statement.includes('WHERE hash =')) {
    return rows.filter((row) => row.hash === params[0]);
  }
  return rows;
}

function mapPost(params: readonly SQLParameter[]): Row {
  return {
    id: params[0],
    author: params[1],
    createdAt: params[2],
    updatedAt: params[3],
    signature: params[4],
    version: params[5],
    text: params[6],
    contentHash: params[7],
    mediaAttachments: params[8],
    replyTo: params[9],
    deleted: params[10],
    revision: params[11],
    previousRevisionHash: params[12],
  };
}

function mapProfile(params: readonly SQLParameter[]): Row {
  return {
    id: params[0],
    author: params[1],
    createdAt: params[2],
    updatedAt: params[3],
    signature: params[4],
    version: params[5],
    username: params[6],
    displayName: params[7],
    bio: params[8],
    avatarHash: params[9],
    postCount: params[10],
    followerCount: params[11],
    followingCount: params[12],
    revision: params[13],
    previousRevisionHash: params[14],
  };
}

function mapFollow(params: readonly SQLParameter[]): Row {
  return {
    id: params[0],
    author: params[1],
    createdAt: params[2],
    updatedAt: params[3],
    signature: params[4],
    version: params[5],
    followerId: params[6],
    followingId: params[7],
    deleted: params[8],
    revision: params[9],
    previousRevisionHash: params[10],
  };
}

function mapComment(params: readonly SQLParameter[]): Row {
  return {
    id: params[0],
    author: params[1],
    createdAt: params[2],
    updatedAt: params[3],
    signature: params[4],
    version: params[5],
    postId: params[6],
    text: params[7],
    contentHash: params[8],
    parentCommentId: params[9],
    deleted: params[10],
    revision: params[11],
    previousRevisionHash: params[12],
  };
}

function mapReaction(params: readonly SQLParameter[]): Row {
  return {
    id: params[0],
    author: params[1],
    createdAt: params[2],
    updatedAt: params[3],
    signature: params[4],
    version: params[5],
    postId: params[6],
    commentId: params[7],
    reactionType: params[8],
    deleted: params[9],
    revision: params[10],
    previousRevisionHash: params[11],
  };
}

function mapChatMessage(params: readonly SQLParameter[]): Row {
  return {
    id: params[0],
    author: params[1],
    createdAt: params[2],
    updatedAt: params[3],
    signature: params[4],
    version: params[5],
    conversationId: params[6],
    senderId: params[7],
    recipientId: params[8],
    text: params[9],
    contentHash: params[10],
    deliveredAt: params[11],
    readAt: params[12],
    relayOnly: params[13],
    deleted: params[14],
    revision: params[15],
    previousRevisionHash: params[16],
  };
}

function mapMediaObject(params: readonly SQLParameter[]): Row {
  return {
    id: params[0],
    author: params[1],
    createdAt: params[2],
    updatedAt: params[3],
    signature: params[4],
    version: params[5],
    type: params[6],
    mime: params[7],
    size: params[8],
    hash: params[9],
    chunks: params[10],
    thumbnail: params[11],
    duration: params[12],
    codec: params[13],
  };
}

function mapMediaChunk(params: readonly SQLParameter[]): Row {
  return {
    id: params[0],
    author: params[1],
    createdAt: params[2],
    updatedAt: params[3],
    signature: params[4],
    version: params[5],
    mediaObjectId: params[6],
    position: params[7],
    size: params[8],
    hash: params[9],
    chunkData: params[10],
  };
}

function mapCanonicalTransaction(params: readonly SQLParameter[]): Row {
  return {
    id: params[0],
    senderId: params[1],
    status: params[2],
    createdAt: params[3],
    updatedAt: params[4],
    data: params[5],
  };
}

function mapReplaySnapshot(params: readonly SQLParameter[]): Row {
  return {
    id: params[0],
    updatedAt: params[1],
    data: params[2],
  };
}

function mapConsensusSnapshot(params: readonly SQLParameter[]): Row {
  return {
    id: params[0],
    updatedAt: params[1],
    data: params[2],
  };
}

function mapSocialDeliveryRecord(params: readonly SQLParameter[]): Row {
  return {
    id: params[0],
    kind: params[1],
    status: params[2],
    messageId: params[3],
    objectId: params[4],
    nextAttemptAt: params[5],
    expiresAt: params[6],
    updatedAt: params[7],
    data: params[8],
  };
}

function mapSyncCheckpoint(params: readonly SQLParameter[]): Row {
  return {
    id: params[0],
    peerId: params[1],
    entity: params[2],
    cursor: params[3],
    manifestHash: params[4],
    status: params[5],
    syncedObjects: params[6],
    updatedAt: params[7],
  };
}

function mapSocialConflictDecision(params: readonly SQLParameter[]): Row {
  return {
    id: params[0],
    entity: params[1],
    entityId: params[2],
    localStateHash: params[3],
    incomingStateHash: params[4],
    winnerStateHash: params[5],
    action: params[6],
    reason: params[7],
    peerId: params[8],
    decidedAt: params[9],
  };
}

function mapMediaDownloadJob(params: readonly SQLParameter[]): Row {
  return {
    id: params[0],
    schemaVersion: params[1],
    status: params[2],
    totalChunks: params[3],
    downloadedChunks: params[4],
    requestedChunks: params[5],
    failedChunks: params[6],
    candidatePeers: params[7],
    error: params[8],
    updatedAt: params[9],
  };
}

function mapMediaAvailabilityAnnouncement(params: readonly SQLParameter[]): Row {
  return {
    id: params[0],
    schemaVersion: params[1],
    peerId: params[2],
    items: params[3],
    updatedAt: params[4],
  };
}

function queryCanonicalTransactions(
  rows: Row[],
  statement: string,
  params: readonly SQLParameter[],
): Row[] {
  if (statement.includes('WHERE id =')) {
    return rows.filter((row) => row.id === params[0]);
  }
  if (statement.includes('WHERE senderId =')) {
    return sortByCreatedAt(rows.filter((row) => row.senderId === params[0]));
  }
  if (statement.includes('WHERE status =')) {
    return sortByCreatedAt(rows.filter((row) => row.status === params[0]));
  }
  return sortByCreatedAt(rows);
}

function queryReplaySnapshots(
  rows: Row[],
  statement: string,
  params: readonly SQLParameter[],
): Row[] {
  if (statement.includes('WHERE id =')) {
    return rows.filter((row) => row.id === params[0]);
  }
  return rows;
}

function queryConsensusSnapshots(
  rows: Row[],
  statement: string,
  params: readonly SQLParameter[],
): Row[] {
  if (statement.includes('WHERE id =')) {
    return rows.filter((row) => row.id === params[0]);
  }
  return rows;
}

function querySocialDeliveryRecords(
  rows: Row[],
  statement: string,
  params: readonly SQLParameter[],
): Row[] {
  let filtered = rows;
  let parameterIndex = 0;
  if (statement.includes('WHERE id =')) {
    return rows.filter((row) => row.id === params[0]);
  }
  if (statement.includes('kind =')) {
    filtered = filtered.filter((row) => row.kind === params[parameterIndex]);
    parameterIndex += 1;
  }
  if (statement.includes('status =')) {
    filtered = filtered.filter((row) => row.status === params[parameterIndex]);
  }
  if (statement.includes('messageId =')) {
    filtered = filtered.filter((row) => row.messageId === params[parameterIndex]);
  }
  return sortByUpdatedAt(filtered);
}

function querySyncCheckpoints(
  rows: Row[],
  statement: string,
  params: readonly SQLParameter[],
): Row[] {
  if (statement.includes('WHERE id =')) {
    return rows.filter((row) => row.id === params[0]);
  }
  if (statement.includes('WHERE peerId =')) {
    return sortByUpdatedAt(rows.filter((row) => row.peerId === params[0]));
  }
  if (statement.includes('WHERE entity =')) {
    return sortByUpdatedAt(rows.filter((row) => row.entity === params[0]));
  }
  return sortByUpdatedAt(rows);
}

function querySocialConflictDecisions(
  rows: Row[],
  statement: string,
  params: readonly SQLParameter[],
): Row[] {
  if (statement.includes('WHERE id =')) {
    return rows.filter((row) => row.id === params[0]);
  }
  if (statement.includes('WHERE entityId =')) {
    return rows
      .filter((row) => row.entityId === params[0])
      .sort((left, right) => Number(left.decidedAt) - Number(right.decidedAt));
  }
  return rows.sort((left, right) => Number(left.decidedAt) - Number(right.decidedAt));
}

function queryMediaPersistenceRows(
  rows: Row[],
  statement: string,
  params: readonly SQLParameter[],
): Row[] {
  if (statement.includes('WHERE id =')) {
    return rows.filter((row) => row.id === params[0]);
  }
  return sortByUpdatedAt(rows);
}

function sortByCreatedAt(rows: Row[]): Row[] {
  return rows.sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0));
}

function sortByUpdatedAt(rows: Row[]): Row[] {
  return rows.sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0));
}

function normalize(statement: string): string {
  return statement.replace(/\s+/g, ' ').trim();
}

function isTableName(value: string): value is TableName {
  return TABLES.includes(value as TableName);
}

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'id' in value;
}

function cloneTables(
  tables: ReadonlyMap<TableName, ReadonlyMap<string, Row>>,
): Map<TableName, Map<string, Row>> {
  return new Map(
    Array.from(tables.entries(), ([tableName, rows]) => [
      tableName,
      new Map(
        Array.from(rows.entries(), ([id, row]) => [
          id,
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              value instanceof Uint8Array ? new Uint8Array(value) : value,
            ]),
          ) as Row,
        ]),
      ),
    ]),
  );
}

function ensureIndex(store: IDBObjectStore, name: string, keyPath: string): void {
  if (!store.indexNames.contains(name)) {
    store.createIndex(name, keyPath, { unique: false });
  }
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}
