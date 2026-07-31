import { MediaChunk, type MediaChunkData } from '@/models/MediaChunk';
import type { MediaObjectData } from '@/models/MediaObject';
import type { PeerId } from '@/network/NetworkTypes';
import { sha256Hex } from '@/utils/hash';

import type { MediaAvailabilityAnnouncementV2 } from '../MediaAvailability';
import { MediaRepairService } from '../MediaRepairService';

describe('MediaRepairService', () => {
  it('offers under-replicated media and confirms only after complete V2 availability', async () => {
    const media = createMedia();
    const completePeers = new Set<PeerId>(['peer-a' as PeerId]);
    const offers: Array<{ peerId: PeerId; mediaObjectId: string }> = [];
    const service = createService(media, completePeers, offers);

    service.start();
    await service.runRepair('test');

    expect(offers).toEqual([
      { peerId: 'peer-b', mediaObjectId: media.object.id },
      { peerId: 'peer-c', mediaObjectId: media.object.id },
    ]);
    expect(service.getSnapshot()).toMatchObject({
      pendingOffers: 2,
      confirmedRepairs: 0,
      underReplicatedObjects: 1,
    });

    service.handleAvailabilityAnnouncement(createAnnouncement('peer-b', media.object, false));
    await flushPromises();
    expect(service.getSnapshot().confirmedRepairs).toBe(0);

    completePeers.add('peer-b' as PeerId);
    service.handleAvailabilityAnnouncement(createAnnouncement('peer-b', media.object, true));
    await flushPromises();
    expect(service.getSnapshot()).toMatchObject({
      pendingOffers: 1,
      confirmedRepairs: 1,
    });
    service.stop();
    expect(service.getSnapshot()).toMatchObject({
      running: false,
      pendingOffers: 0,
      queuedObjects: 0,
    });
  });

  it('does not offer when the minimum complete replica count is already met', async () => {
    const media = createMedia();
    const completePeers = new Set<PeerId>(['peer-a' as PeerId, 'peer-b' as PeerId]);
    const offers: Array<{ peerId: PeerId; mediaObjectId: string }> = [];
    const service = createService(media, completePeers, offers);

    service.start();
    await service.runRepair('test');

    expect(offers).toEqual([]);
    expect(service.getSnapshot().underReplicatedObjects).toBe(0);
    service.stop();
  });

  it('backs off a failed offer instead of retrying it in the same repair window', async () => {
    const media = createMedia();
    const attempts: PeerId[] = [];
    const service = new MediaRepairService(
      'peer-a' as PeerId,
      {
        getCount: async () => 1,
        getAll: async () => [media.object],
        getById: async (id) => (id === media.object.id ? media.object : null),
      },
      {
        getByMediaObjectId: async () => media.chunks,
      },
      {
        findCompleteReplicaPeers: () => ['peer-a' as PeerId],
        isReplicaQuarantined: () => false,
      },
      {
        getEligiblePeers: () => ['peer-b' as PeerId],
        offerReplica: async (peerId) => {
          attempts.push(peerId);
          return false;
        },
      },
      undefined,
      { desiredReplicas: 2, retryBackoffMs: 60_000 },
    );

    service.start();
    await service.runRepair('first');
    await service.runRepair('second');

    expect(attempts).toEqual(['peer-b']);
    expect(service.getSnapshot().failedOffers).toBe(1);
    service.stop();
  });
});

function createService(
  media: { object: MediaObjectData; chunks: MediaChunkData[] },
  completePeers: Set<PeerId>,
  offers: Array<{ peerId: PeerId; mediaObjectId: string }>,
): MediaRepairService {
  return new MediaRepairService(
    'peer-a' as PeerId,
    {
      getCount: async () => 1,
      getAll: async () => [media.object],
      getById: async (id) => (id === media.object.id ? media.object : null),
    },
    {
      getByMediaObjectId: async () => media.chunks,
    },
    {
      findCompleteReplicaPeers: () => [...completePeers],
      isReplicaQuarantined: () => false,
    },
    {
      getEligiblePeers: () => ['peer-b' as PeerId, 'peer-c' as PeerId],
      offerReplica: async (peerId, mediaObjectId) => {
        offers.push({ peerId, mediaObjectId });
        return true;
      },
    },
  );
}

function createMedia(): { object: MediaObjectData; chunks: MediaChunkData[] } {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const chunk = MediaChunk.create('media-a', 0, bytes, 'peer-a' as PeerId).getData();
  return {
    object: {
      id: 'media-a',
      author: 'peer-a' as PeerId,
      createdAt: 1,
      updatedAt: 1,
      signature: 'signature',
      version: '1.0',
      type: 'image',
      mime: 'image/png',
      size: bytes.length,
      hash: sha256Hex(bytes),
      chunks: [chunk.id],
    },
    chunks: [chunk],
  };
}

function createAnnouncement(
  peerId: PeerId,
  mediaObject: MediaObjectData,
  complete: boolean,
): MediaAvailabilityAnnouncementV2 {
  return {
    version: 2,
    peerId,
    sequence: 1,
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
    pageIndex: 0,
    pageCount: 1,
    items: [
      {
        mediaObjectId: mediaObject.id,
        chunks: complete ? [...mediaObject.chunks] : [],
        totalChunks: mediaObject.chunks.length,
        updatedAt: 1,
      },
    ],
    signature: 'verified-before-delivery',
  };
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}
