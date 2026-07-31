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
import type { MediaAvailabilityAnnouncementV2 } from '../MediaAvailability';
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
    await firstRepository.saveAnnouncement(createAnnouncement());
    await firstRepository.touchMediaAccess('media-a', 30);
    await firstRepository.setMediaProtected('media-a', true, 31);
    await firstDatabase.close();

    const secondDatabase = await openDatabaseService({ databaseName });
    const secondRepository = new MediaDownloadRepository(secondDatabase);
    await secondRepository.initialize();

    expect(secondRepository.getState('media-a')).toMatchObject({
      status: 'partial',
      downloadedChunks: 1,
    });
    expect(secondRepository.findPeersForChunk('media-a', 'chunk-a')).toEqual(['peer-a']);
    expect(secondRepository.getMediaAccess('media-a')).toEqual({
      mediaObjectId: 'media-a',
      protected: true,
      lastAccessedAt: 30,
      updatedAt: 31,
    });

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

  it('persists signed announcements, replica observations and quarantine across reopen', async () => {
    const databaseName = 'synpeer-media-source-health-reopen';
    const firstDatabase = await openDatabaseService({ databaseName });
    const firstRepository = new MediaDownloadRepository(firstDatabase);
    await firstRepository.initialize();

    await expect(firstRepository.saveAnnouncement(createAnnouncement())).resolves.toBe('saved');
    await firstRepository.recordReplicaResult({
      peerId: 'peer-a' as PeerId,
      mediaObjectId: 'media-a',
      chunkId: 'chunk-a',
      status: 'success',
      latencyMs: 42,
      now: 20,
    });
    await firstRepository.quarantineReplica({
      peerId: 'peer-b' as PeerId,
      mediaObjectId: 'media-a',
      chunkId: 'chunk-a',
      reason: 'chunk-hash-mismatch',
      evidenceHash: 'evidence',
      durationMs: 1000,
      now: 20,
    });
    await firstDatabase.close();

    const reopenedDatabase = await openDatabaseService({ databaseName });
    const reopenedRepository = new MediaDownloadRepository(reopenedDatabase);
    await reopenedRepository.initialize();

    expect(reopenedRepository.listAnnouncements()).toEqual([createAnnouncement()]);
    expect(
      reopenedRepository.getReplicaObservation('peer-a' as PeerId, 'media-a', 'chunk-a'),
    ).toMatchObject({
      status: 'success',
      successCount: 1,
      failureCount: 0,
      latencyMs: 42,
    });
    expect(
      reopenedRepository.isReplicaQuarantined('peer-b' as PeerId, 'media-a', 'chunk-a', 21),
    ).toBe(true);
    expect(
      reopenedRepository.isReplicaQuarantined('peer-b' as PeerId, 'media-a', 'chunk-a', 1020),
    ).toBe(false);
    await reopenedDatabase.close();
  });

  it('rejects stale and conflicting announcement pages without replacing current state', async () => {
    const database = await openDatabaseService({
      databaseName: 'synpeer-media-announcement-sequence',
    });
    const repository = new MediaDownloadRepository(database);
    await repository.initialize();
    const current = createAnnouncement({ sequence: 2, signature: 'signature-current' });

    await expect(repository.saveAnnouncement(current)).resolves.toBe('saved');
    await expect(repository.saveAnnouncement(createAnnouncement({ sequence: 1 }))).resolves.toBe(
      'stale',
    );
    await expect(repository.saveAnnouncement(current)).resolves.toBe('duplicate');
    await expect(
      repository.saveAnnouncement({ ...current, signature: 'signature-conflict' }),
    ).resolves.toBe('conflict');
    expect(repository.listAnnouncements()).toEqual([current]);
    await database.close();
  });

  it('counts a replica only when every signed announcement page covers the full manifest', async () => {
    const database = await openDatabaseService({
      databaseName: 'synpeer-media-complete-replica-pages',
    });
    const repository = new MediaDownloadRepository(database);
    await repository.initialize();
    const shared = {
      sequence: 3,
      issuedAt: 20,
      expiresAt: 4_102_444_800_000,
      pageCount: 2,
    };

    await repository.saveAnnouncement(
      createAnnouncement({
        ...shared,
        pageIndex: 0,
        items: [{ mediaObjectId: 'media-a', chunks: ['chunk-a'], totalChunks: 2, updatedAt: 20 }],
      }),
    );
    expect(repository.findCompleteReplicaPeers('media-a', ['chunk-a', 'chunk-b'])).toEqual([]);

    await repository.saveAnnouncement(
      createAnnouncement({
        ...shared,
        pageIndex: 1,
        items: [{ mediaObjectId: 'media-a', chunks: ['chunk-b'], totalChunks: 2, updatedAt: 20 }],
      }),
    );
    expect(repository.findCompleteReplicaPeers('media-a', ['chunk-a', 'chunk-b'])).toEqual([
      'peer-a',
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
    await repository.saveAnnouncement(createAnnouncement());
    await repository.recordReplicaResult({
      peerId: 'peer-a' as PeerId,
      mediaObjectId: 'media-a',
      chunkId: 'chunk-a',
      status: 'unavailable',
    });
    await repository.quarantineReplica({
      peerId: 'peer-a' as PeerId,
      mediaObjectId: 'media-a',
      chunkId: 'chunk-a',
      reason: 'chunk-hash-mismatch',
      durationMs: 1000,
    });
    await repository.touchMediaAccess('media-a', 20);

    await repository.clear();

    expect(repository.listStates()).toEqual([]);
    expect(repository.listManifests()).toEqual([]);
    expect(repository.listAnnouncements()).toEqual([]);
    expect(repository.listReplicaObservations()).toEqual([]);
    expect(repository.listQuarantines()).toEqual([]);
    expect(repository.listMediaAccess()).toEqual([]);
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

function createAnnouncement(
  overrides: Partial<MediaAvailabilityAnnouncementV2> = {},
): MediaAvailabilityAnnouncementV2 {
  return {
    version: 2,
    peerId: 'peer-a' as PeerId,
    sequence: 1,
    issuedAt: 10,
    expiresAt: 4_102_444_800_000,
    pageIndex: 0,
    pageCount: 1,
    items: createManifest().items,
    signature: 'signature',
    ...overrides,
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
