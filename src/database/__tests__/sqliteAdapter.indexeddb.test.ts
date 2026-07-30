import { IDBDatabase, IDBFactory, IDBTransaction } from 'fake-indexeddb';

import type { SQLParameter } from '../DatabaseService';
import { openDatabaseService } from '../sqliteAdapter.web';

const INSERT_DELIVERY_RECORD = `
  INSERT OR REPLACE INTO social_delivery_records
  (id, kind, status, messageId, objectId, nextAttemptAt, expiresAt, updatedAt, data)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
`;

describe('sqliteAdapter.web IndexedDB transactions', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('commits all transaction writes together', async () => {
    const database = await openDatabaseService({ databaseName: 'synpeer-transaction-commit' });

    await database.transaction(async (transaction) => {
      await transaction.run(INSERT_DELIVERY_RECORD, createDeliveryParams('record-a'));
      await transaction.run(INSERT_DELIVERY_RECORD, createDeliveryParams('record-b'));
    });

    await expect(database.query('SELECT * FROM social_delivery_records;')).resolves.toHaveLength(2);
    await database.close();
  });

  it('rolls back transaction writes when the unit of work fails', async () => {
    const database = await openDatabaseService({ databaseName: 'synpeer-transaction-rollback' });

    await expect(
      database.transaction(async (transaction) => {
        await transaction.run(INSERT_DELIVERY_RECORD, createDeliveryParams('record-a'));
        throw new Error('synthetic failure');
      }),
    ).rejects.toThrow('synthetic failure');

    await expect(database.query('SELECT * FROM social_delivery_records;')).resolves.toEqual([]);
    await database.close();
  });

  it('upgrades a version 5 database without destroying existing records', async () => {
    const databaseName = 'synpeer-version-5-upgrade';
    await seedVersionFiveDatabase(databaseName);

    const database = await openDatabaseService({ databaseName });
    await expect(database.query('SELECT * FROM posts;')).resolves.toEqual([
      expect.objectContaining({
        id: 'legacy-post',
        text: 'preserved',
      }),
    ]);
    await database.close();

    const upgraded = await openRawDatabase(databaseName);
    expect(upgraded.version).toBe(9);
    expect(upgraded.objectStoreNames.contains('social_delivery_records')).toBe(true);
    expect(upgraded.objectStoreNames.contains('sync_checkpoints')).toBe(true);
    expect(upgraded.objectStoreNames.contains('social_conflict_decisions')).toBe(true);
    expect(upgraded.objectStoreNames.contains('media_download_jobs')).toBe(true);
    expect(upgraded.objectStoreNames.contains('media_availability_announcements')).toBe(true);
    expect(upgraded.objectStoreNames.contains('media_replica_observations')).toBe(true);
    expect(upgraded.objectStoreNames.contains('media_quarantine_records')).toBe(true);
    expect(upgraded.objectStoreNames.contains('media_access_records')).toBe(true);
    upgraded.close();
  });
});

function createDeliveryParams(id: string): readonly SQLParameter[] {
  return [id, 'outbox', 'pending', null, id, 1, 100, 1, JSON.stringify({ id })];
}

async function seedVersionFiveDatabase(databaseName: string): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = globalThis.indexedDB.open(databaseName, 5);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('posts', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = database.transaction('posts', 'readwrite');
  transaction.objectStore('posts').put({
    id: 'legacy-post',
    author: 'peer-a',
    createdAt: 1,
    updatedAt: 1,
    signature: 'signature',
    version: '2.0.0',
    text: 'preserved',
    replyTo: null,
    contentHash: 'hash',
    mediaAttachments: '[]',
    deleted: 0,
  });
  await transactionCompletion(transaction);
  database.close();
}

async function openRawDatabase(databaseName: string): Promise<IDBDatabase> {
  return await new Promise<IDBDatabase>((resolve, reject) => {
    const request = globalThis.indexedDB.open(databaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}
