import { IDBFactory } from 'fake-indexeddb';

import { openDatabaseService } from '@/database/sqliteAdapter.web';
import type { PeerId } from '@/network/NetworkTypes';
import { sha256Hex } from '@/utils/hash';

import {
  MEDIA_AVAILABILITY_MAX_ITEMS_PER_PAGE,
  type MediaAvailabilityCrypto,
  type MediaAvailabilityItem,
} from '../MediaAvailability';
import { MediaAvailabilityService } from '../MediaAvailabilityService';
import { MediaDownloadRepository } from '../MediaDownloadRepository';

describe('MediaAvailabilityService', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('creates signed pages and accepts them only from the authenticated sender', async () => {
    const repositoryA = await createRepository('availability-create-a');
    const repositoryB = await createRepository('availability-create-b');
    const serviceA = new MediaAvailabilityService(
      'peer-a' as PeerId,
      new TestMediaCrypto('peer-a'),
      repositoryA,
      { now: () => 1000 },
    );
    const serviceB = new MediaAvailabilityService(
      'peer-b' as PeerId,
      new TestMediaCrypto('peer-b'),
      repositoryB,
      { now: () => 1001 },
    );
    const accepted = jest.fn();
    const unsubscribe = serviceB.subscribeAccepted(accepted);

    const [announcement] = await serviceA.createAnnouncements([createItem('media-a')]);

    expect(announcement).toMatchObject({
      version: 2,
      peerId: 'peer-a',
      sequence: 1,
      issuedAt: 1000,
      pageIndex: 0,
      pageCount: 1,
    });
    await expect(
      serviceB.acceptAnnouncement(announcement, 'peer-other' as PeerId),
    ).resolves.toEqual({
      accepted: false,
      reason: 'wrong-sender',
    });
    await expect(
      serviceB.acceptAnnouncement(announcement, 'peer-a' as PeerId),
    ).resolves.toMatchObject({
      accepted: true,
    });
    expect(repositoryB.findPeersForChunk('media-a', 'chunk-media-a', 1002)).toEqual(['peer-a']);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledWith(announcement);
    await serviceB.acceptAnnouncement(announcement, 'peer-a' as PeerId);
    expect(accepted).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('rejects tampering, expiration, duplicates and stale sequences explicitly', async () => {
    const repositoryA = await createRepository('availability-validation-a');
    const repositoryB = await createRepository('availability-validation-b');
    let now = 2000;
    const serviceA = new MediaAvailabilityService(
      'peer-a' as PeerId,
      new TestMediaCrypto('peer-a'),
      repositoryA,
      { now: () => now, ttlMs: 1000 },
    );
    const serviceB = new MediaAvailabilityService(
      'peer-b' as PeerId,
      new TestMediaCrypto('peer-b'),
      repositoryB,
      { now: () => now },
    );
    const [first] = await serviceA.createAnnouncements([createItem('media-a')]);

    await expect(
      serviceB.acceptAnnouncement(
        {
          ...first,
          items: [{ ...first.items[0], chunks: ['tampered'] }],
        },
        'peer-a' as PeerId,
      ),
    ).resolves.toEqual({ accepted: false, reason: 'signature-invalid' });
    await expect(serviceB.acceptAnnouncement(first, 'peer-a' as PeerId)).resolves.toMatchObject({
      accepted: true,
    });
    await expect(serviceB.acceptAnnouncement(first, 'peer-a' as PeerId)).resolves.toEqual({
      accepted: false,
      reason: 'duplicate',
    });

    now = 2200;
    const [second] = await serviceA.createAnnouncements([createItem('media-b')]);
    await expect(serviceB.acceptAnnouncement(second, 'peer-a' as PeerId)).resolves.toMatchObject({
      accepted: true,
    });
    await expect(serviceB.acceptAnnouncement(first, 'peer-a' as PeerId)).resolves.toEqual({
      accepted: false,
      reason: 'stale',
    });

    now = 4000;
    await expect(serviceB.acceptAnnouncement(second, 'peer-a' as PeerId)).resolves.toEqual({
      accepted: false,
      reason: 'expired',
    });
  });

  it('paginates large availability sets while preserving one signed sequence', async () => {
    const repository = await createRepository('availability-pagination');
    const service = new MediaAvailabilityService(
      'peer-a' as PeerId,
      new TestMediaCrypto('peer-a'),
      repository,
      { now: () => 5000 },
    );
    const items = Array.from({ length: MEDIA_AVAILABILITY_MAX_ITEMS_PER_PAGE + 5 }, (_, index) =>
      createItem(`media-${index}`),
    );

    const announcements = await service.createAnnouncements(items);

    expect(announcements).toHaveLength(2);
    expect(new Set(announcements.map((announcement) => announcement.sequence))).toEqual(
      new Set([1]),
    );
    expect(announcements.map((announcement) => announcement.pageIndex)).toEqual([0, 1]);
    expect(announcements.every((announcement) => announcement.pageCount === 2)).toBe(true);
    expect(repository.listAnnouncements('peer-a' as PeerId)).toHaveLength(2);
  });

  it('preserves the sequence head after expiration so a restarted publisher remains monotonic', async () => {
    const repository = await createRepository('availability-sequence-head');
    let now = 10_000;
    const service = new MediaAvailabilityService(
      'peer-a' as PeerId,
      new TestMediaCrypto('peer-a'),
      repository,
      { now: () => now, ttlMs: 100 },
    );

    const [first] = await service.createAnnouncements([createItem('media-a')]);
    now = 11_000;
    await service.pruneExpired();
    const [second] = await service.createAnnouncements([createItem('media-b')]);

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(repository.listAnnouncements('peer-a' as PeerId)).toEqual([second]);
  });

  it('removes persisted announcements whose signature no longer validates', async () => {
    const repository = await createRepository('availability-corrupt-persisted');
    await repository.saveAnnouncement({
      version: 2,
      peerId: 'peer-a' as PeerId,
      sequence: 1,
      issuedAt: 1000,
      expiresAt: 2000,
      pageIndex: 0,
      pageCount: 1,
      items: [createItem('media-a')],
      signature: 'corrupt-signature',
    });
    const service = new MediaAvailabilityService(
      'peer-b' as PeerId,
      new TestMediaCrypto('peer-b'),
      repository,
      { now: () => 1500 },
    );

    await expect(service.initialize()).resolves.toEqual({
      invalidAnnouncementsRemoved: 1,
      expiredAnnouncementsRemoved: 0,
    });
    expect(repository.listAnnouncements()).toEqual([]);
  });
});

class TestMediaCrypto implements MediaAvailabilityCrypto {
  constructor(private readonly identity: string) {}

  async sign(data: string): Promise<string> {
    return sha256Hex(`${this.identity}:${data}`);
  }

  async verify(data: string, signature: string, publicIdentity: string): Promise<boolean> {
    return signature === sha256Hex(`${publicIdentity}:${data}`);
  }
}

async function createRepository(databaseName: string): Promise<MediaDownloadRepository> {
  const database = await openDatabaseService({ databaseName });
  const repository = new MediaDownloadRepository(database);
  await repository.initialize();
  return repository;
}

function createItem(mediaObjectId: string): MediaAvailabilityItem {
  return {
    mediaObjectId,
    chunks: [`chunk-${mediaObjectId}`],
    totalChunks: 1,
    updatedAt: 1000,
  };
}
