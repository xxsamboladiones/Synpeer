import { AppError } from '@/errors/AppError';
import type { PeerId } from '@/network/NetworkTypes';
import { openDatabaseService } from '@/database/sqliteAdapter.web';
import { IDBFactory } from 'fake-indexeddb';

import { SyncCheckpointRepository } from '../SyncCheckpointRepository';

const INSERT_CHECKPOINT = `
  INSERT OR REPLACE INTO sync_checkpoints
  (id, peerId, entity, cursor, manifestHash, status, syncedObjects, updatedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?);
`;

describe('SyncCheckpointRepository', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('persists resumable progress and reconstructs it in a new repository instance', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    const peerId = 'peer-b' as PeerId;
    const repository = new SyncCheckpointRepository(database);

    await repository.saveProgress({
      peerId,
      entity: 'post',
      cursor: '200:post-b',
      manifestHash: 'manifest-v1',
      syncedObjects: 2,
      now: 10,
    });

    const restored = new SyncCheckpointRepository(database);
    await expect(restored.get(peerId, 'post')).resolves.toMatchObject({
      peerId,
      entity: 'post',
      cursor: '200:post-b',
      manifestHash: 'manifest-v1',
      status: 'scanning',
      syncedObjects: 2,
    });

    await restored.markComplete({
      peerId,
      entity: 'post',
      manifestHash: 'manifest-v1',
      syncedObjects: 1,
      now: 20,
    });
    await expect(repository.get(peerId, 'post')).resolves.toMatchObject({
      status: 'complete',
      cursor: undefined,
      syncedObjects: 3,
    });
  });

  it('keeps independent checkpoints per peer and entity and clears one peer atomically', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    const repository = new SyncCheckpointRepository(database);
    await repository.markComplete({
      peerId: 'peer-a',
      entity: 'post',
      manifestHash: 'posts-a',
    });
    await repository.markComplete({
      peerId: 'peer-a',
      entity: 'profile',
      manifestHash: 'profiles-a',
    });
    await repository.markComplete({
      peerId: 'peer-b',
      entity: 'post',
      manifestHash: 'posts-b',
    });

    await repository.clearPeer('peer-a');

    await expect(repository.list('peer-a')).resolves.toEqual([]);
    await expect(repository.list('peer-b')).resolves.toHaveLength(1);
  });

  it('rejects corrupt persisted checkpoint rows', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    const repository = new SyncCheckpointRepository(database);
    await database.run(INSERT_CHECKPOINT, [
      'peer-a:post',
      'peer-a',
      'invalid-entity',
      null,
      'hash',
      'complete',
      0,
      1,
    ]);

    await expect(repository.list()).rejects.toBeInstanceOf(AppError);
  });

  it('survives a real IndexedDB close and reopen', async () => {
    const databaseName = 'synpeer-sync-checkpoint-reopen';
    const firstDatabase = await openDatabaseService({ databaseName });
    const firstRepository = new SyncCheckpointRepository(firstDatabase);
    await firstRepository.saveProgress({
      peerId: 'peer-b',
      entity: 'comment',
      cursor: '300:comment-c',
      manifestHash: 'comment-manifest',
      syncedObjects: 4,
    });
    await firstDatabase.close();

    const secondDatabase = await openDatabaseService({ databaseName });
    const secondRepository = new SyncCheckpointRepository(secondDatabase);
    await expect(secondRepository.get('peer-b', 'comment')).resolves.toMatchObject({
      cursor: '300:comment-c',
      manifestHash: 'comment-manifest',
      syncedObjects: 4,
    });
    await secondDatabase.close();
  });
});
