import { IDBFactory } from 'fake-indexeddb';

import type { DatabaseService } from '@/database/DatabaseService';
import { openDatabaseService } from '@/database/sqliteAdapter.web';
import { AppError } from '@/errors/AppError';
import type { PeerId } from '@/network/NetworkTypes';
import { createStorageService, type StorageService } from '@/services/storage/StorageService';

import {
  LEGACY_MEDIA_AVAILABILITY_KEY,
  LEGACY_MEDIA_DOWNLOAD_STATES_KEY,
  MediaDownloadRepository,
  type MediaAvailabilityManifest,
} from '../MediaDownloadRepository';
import type { MediaDownloadState } from '../PeerMediaSyncService';

describe('MediaDownloadRepository', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('persists download jobs and availability across database reopen', async () => {
    const databaseName = 'synpeer-media-persistence-reopen';
    const firstDatabase = await openDatabaseService({ databaseName });
    const firstRepository = new MediaDownloadRepository(firstDatabase);
    await firstRepository.initialize();

    await firstRepository.saveState(createState({ status: 'partial', downloadedChunks: 1 }));
    await firstRepository.saveManifest(createManifest());
    await firstDatabase.close();

    const secondDatabase = await openDatabaseService({ databaseName });
    const secondRepository = new MediaDownloadRepository(secondDatabase);
    await secondRepository.initialize();

    expect(secondRepository.getState('media-a')).toMatchObject({
      status: 'partial',
      downloadedChunks: 1,
    });
    expect(secondRepository.findPeersForChunk('media-a', 'chunk-a')).toEqual(['peer-a']);

    await secondRepository.removeState('media-a');
    expect(secondRepository.getState('media-a')).toBeNull();
    await secondDatabase.close();
  });

  it('initializes once when called concurrently and ignores duplicate chunks', async () => {
    const database = await openDatabaseService({ databaseName: 'synpeer-media-concurrent-init' });
    const repository = new MediaDownloadRepository(database);

    const [first, second] = await Promise.all([repository.initialize(), repository.initialize()]);
    expect(first).toEqual(second);

    await repository.recordChunkAvailability('peer-a' as PeerId, 'media-a', 'chunk-a');
    await repository.recordChunkAvailability('peer-a' as PeerId, 'media-a', 'chunk-a');

    expect(repository.getManifest('peer-a' as PeerId)?.items).toEqual([
      expect.objectContaining({
        chunks: ['chunk-a'],
        totalChunks: 1,
      }),
    ]);
    await database.close();
  });

  it('imports legacy records once and removes them only after commit', async () => {
    const legacy = createMemoryStorage();
    legacy.storage.setJson(LEGACY_MEDIA_DOWNLOAD_STATES_KEY, {
      'media-a': createState(),
    });
    legacy.storage.setJson(LEGACY_MEDIA_AVAILABILITY_KEY, {
      'peer-a': createManifest(),
    });
    const databaseName = 'synpeer-media-legacy-migration';
    const database = await openDatabaseService({ databaseName });
    const repository = new MediaDownloadRepository(database, legacy.storage);

    await expect(repository.initialize()).resolves.toEqual({
      migratedDownloadJobs: 1,
      migratedAvailabilityAnnouncements: 1,
      legacyDataRemoved: true,
    });
    expect(legacy.storage.getString(LEGACY_MEDIA_DOWNLOAD_STATES_KEY)).toBeNull();
    expect(legacy.storage.getString(LEGACY_MEDIA_AVAILABILITY_KEY)).toBeNull();
    await database.close();

    const reopenedDatabase = await openDatabaseService({ databaseName });
    const reopenedRepository = new MediaDownloadRepository(reopenedDatabase, legacy.storage);
    await expect(reopenedRepository.initialize()).resolves.toEqual({
      migratedDownloadJobs: 0,
      migratedAvailabilityAnnouncements: 0,
      legacyDataRemoved: false,
    });
    expect(reopenedRepository.getState('media-a')).not.toBeNull();
    await reopenedDatabase.close();
  });

  it('keeps a newer persisted record when legacy data is older', async () => {
    const database = await openDatabaseService({ databaseName: 'synpeer-media-newest-wins' });
    const currentRepository = new MediaDownloadRepository(database);
    await currentRepository.initialize();
    await currentRepository.saveState(createState({ status: 'available', updatedAt: 20 }));

    const legacy = createMemoryStorage();
    legacy.storage.setJson(LEGACY_MEDIA_DOWNLOAD_STATES_KEY, {
      'media-a': createState({ status: 'failed', updatedAt: 10 }),
    });
    const migratedRepository = new MediaDownloadRepository(database, legacy.storage);

    await expect(migratedRepository.initialize()).resolves.toMatchObject({
      migratedDownloadJobs: 0,
      legacyDataRemoved: true,
    });
    expect(migratedRepository.getState('media-a')?.status).toBe('available');
    await database.close();
  });

  it('preserves corrupt legacy data and reports a typed storage error', async () => {
    const legacy = createMemoryStorage();
    legacy.storage.setString(LEGACY_MEDIA_DOWNLOAD_STATES_KEY, '{invalid');
    const database = await openDatabaseService({ databaseName: 'synpeer-media-corrupt-legacy' });
    const repository = new MediaDownloadRepository(database, legacy.storage);

    const initialization = repository.initialize();
    await expect(initialization).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
      retryable: false,
    });
    await expect(initialization).rejects.toBeInstanceOf(AppError);
    expect(legacy.storage.getString(LEGACY_MEDIA_DOWNLOAD_STATES_KEY)).toBe('{invalid');
    await database.close();
  });

  it('preserves legacy data when the migration transaction fails', async () => {
    const legacy = createMemoryStorage();
    legacy.storage.setJson(LEGACY_MEDIA_DOWNLOAD_STATES_KEY, {
      'media-a': createState(),
    });
    const database = await openDatabaseService({ databaseName: 'synpeer-media-failed-migration' });
    const repository = new MediaDownloadRepository(
      createFailingMigrationDatabase(database),
      legacy.storage,
    );

    await expect(repository.initialize()).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
      retryable: true,
    });
    expect(legacy.storage.getString(LEGACY_MEDIA_DOWNLOAD_STATES_KEY)).not.toBeNull();
    await database.close();
  });

  it('rejects corrupt persisted records instead of loading them into runtime state', async () => {
    const database = await openDatabaseService({ databaseName: 'synpeer-media-corrupt-row' });
    await database.run(
      `
      INSERT OR REPLACE INTO media_download_jobs
      (id, schemaVersion, status, totalChunks, downloadedChunks, requestedChunks, failedChunks, candidatePeers, error, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      ['media-corrupt', 1, 'queued', 1, 0, 0, 0, 'not-json', null, 10],
    );
    const repository = new MediaDownloadRepository(database);

    await expect(repository.initialize()).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
      retryable: false,
    });
    await database.close();
  });

  it('clears download and availability data atomically', async () => {
    const database = await openDatabaseService({ databaseName: 'synpeer-media-clear' });
    const repository = new MediaDownloadRepository(database);
    await repository.initialize();
    await repository.saveState(createState());
    await repository.saveManifest(createManifest());

    await repository.clear();

    expect(repository.listStates()).toEqual([]);
    expect(repository.listManifests()).toEqual([]);
    await database.close();
  });
});

function createState(overrides: Partial<MediaDownloadState> = {}): MediaDownloadState {
  return {
    mediaObjectId: 'media-a',
    status: 'queued',
    totalChunks: 2,
    downloadedChunks: 0,
    requestedChunks: 0,
    failedChunks: 0,
    candidatePeers: ['peer-a' as PeerId],
    updatedAt: 10,
    ...overrides,
  };
}

function createManifest(): MediaAvailabilityManifest {
  return {
    peerId: 'peer-a' as PeerId,
    items: [
      {
        mediaObjectId: 'media-a',
        chunks: ['chunk-a'],
        totalChunks: 2,
        updatedAt: 10,
      },
    ],
    updatedAt: 10,
  };
}

function createMemoryStorage(): {
  storage: StorageService;
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    storage: createStorageService({
      getString: (key) => values.get(key) ?? null,
      setString: (key, value) => {
        values.set(key, value);
      },
      remove: (key) => {
        values.delete(key);
      },
      clear: () => {
        values.clear();
      },
    }),
  };
}

function createFailingMigrationDatabase(database: DatabaseService): DatabaseService {
  return {
    execute: async (statement) => await database.execute(statement),
    run: async (statement, params) => await database.run(statement, params),
    query: async (statement, params) => await database.query(statement, params),
    transaction: async (work) =>
      await database.transaction(async (transaction) => {
        let failingTransaction: DatabaseService;
        failingTransaction = {
          execute: async (statement) => await transaction.execute(statement),
          run: async (statement, params) => {
            if (statement.includes('media_download_jobs')) {
              throw new Error('synthetic media migration failure');
            }
            await transaction.run(statement, params);
          },
          query: async (statement, params) => await transaction.query(statement, params),
          transaction: async (nestedWork) => await nestedWork(failingTransaction),
          close: async () => undefined,
          reset: async () => undefined,
          getCapabilities: () => transaction.getCapabilities(),
        };
        return await work(failingTransaction);
      }),
    close: async () => await database.close(),
    reset: async () => await database.reset(),
    getCapabilities: () => database.getCapabilities(),
  };
}
