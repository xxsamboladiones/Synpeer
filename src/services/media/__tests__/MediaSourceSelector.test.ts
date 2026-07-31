import { IDBFactory } from 'fake-indexeddb';

import { openDatabaseService } from '@/database/sqliteAdapter.web';
import type { PeerId } from '@/network/NetworkTypes';

import type { MediaAvailabilityAnnouncementV2 } from '../MediaAvailability';
import { MediaDownloadRepository } from '../MediaDownloadRepository';
import { MediaSourceSelector } from '../MediaSourceSelector';

describe('MediaSourceSelector', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('orders fresh advertised sources deterministically using persisted reliability', async () => {
    const repository = await createRepository('media-source-order');
    await repository.saveAnnouncement(createAnnouncement('peer-b'));
    await repository.saveAnnouncement(createAnnouncement('peer-a'));
    await repository.recordReplicaResult({
      peerId: 'peer-b' as PeerId,
      mediaObjectId: 'media-a',
      chunkId: 'chunk-a',
      status: 'unavailable',
      now: 1100,
    });
    await repository.recordReplicaResult({
      peerId: 'peer-a' as PeerId,
      mediaObjectId: 'media-a',
      chunkId: 'chunk-a',
      status: 'success',
      latencyMs: 50,
      now: 1100,
    });
    const selector = new MediaSourceSelector(repository, () => 1200);

    expect(
      selector.select({
        mediaObjectId: 'media-a',
        chunkId: 'chunk-a',
        candidatePeers: ['peer-c' as PeerId, 'peer-b' as PeerId],
      }),
    ).toEqual(['peer-a', 'peer-b', 'peer-c']);
  });

  it('ignores expired announcements and excludes quarantined replicas until expiry', async () => {
    const repository = await createRepository('media-source-quarantine');
    await repository.saveAnnouncement(
      createAnnouncement('peer-a', {
        issuedAt: 100,
        expiresAt: 200,
      }),
    );
    await repository.saveAnnouncement(createAnnouncement('peer-b'));
    await repository.quarantineReplica({
      peerId: 'peer-b' as PeerId,
      mediaObjectId: 'media-a',
      chunkId: 'chunk-a',
      reason: 'chunk-hash-mismatch',
      durationMs: 500,
      now: 1000,
    });
    const selector = new MediaSourceSelector(repository);

    expect(
      selector.select({
        mediaObjectId: 'media-a',
        chunkId: 'chunk-a',
        candidatePeers: ['peer-a' as PeerId, 'peer-b' as PeerId, 'peer-c' as PeerId],
        now: 1200,
      }),
    ).toEqual(['peer-a', 'peer-c']);
    expect(
      selector.select({
        mediaObjectId: 'media-a',
        chunkId: 'chunk-a',
        candidatePeers: ['peer-a' as PeerId, 'peer-b' as PeerId, 'peer-c' as PeerId],
        now: 1600,
      }),
    ).toEqual(['peer-b', 'peer-a', 'peer-c']);
  });
});

async function createRepository(databaseName: string): Promise<MediaDownloadRepository> {
  const database = await openDatabaseService({ databaseName });
  const repository = new MediaDownloadRepository(database);
  await repository.initialize();
  return repository;
}

function createAnnouncement(
  peerId: string,
  overrides: Partial<MediaAvailabilityAnnouncementV2> = {},
): MediaAvailabilityAnnouncementV2 {
  return {
    version: 2,
    peerId: peerId as PeerId,
    sequence: 1,
    issuedAt: 1000,
    expiresAt: 2000,
    pageIndex: 0,
    pageCount: 1,
    items: [
      {
        mediaObjectId: 'media-a',
        chunks: ['chunk-a'],
        totalChunks: 1,
        updatedAt: 1000,
      },
    ],
    signature: `signature-${peerId}`,
    ...overrides,
  };
}
