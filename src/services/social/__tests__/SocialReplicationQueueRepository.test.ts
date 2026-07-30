import { openDatabaseService } from '@/database/sqliteAdapter.web';
import { AppError } from '@/errors/AppError';
import { createNetworkMessage, type NetworkMessage } from '@/network/NetworkMessage';
import type { PeerId } from '@/network/NetworkTypes';
import type { PeerConnection, PeerTransport } from '@/network/PeerTransport';
import { createStorageService, type StorageDriver } from '@/services/storage/StorageService';
import { sha256Hex } from '@/utils/hash';

import {
  createQueueItemId,
  SOCIAL_OUTBOX_DELIVERY_TTL_MS,
  SocialReplicationQueueRepository,
} from '../SocialReplicationQueueRepository';
import {
  createSocialAckPayload,
  isSocialWirePayload,
  SocialReplicationService,
  type SocialWirePayload,
} from '../SocialReplicationService';

async function createRepository(): Promise<SocialReplicationQueueRepository> {
  return new SocialReplicationQueueRepository(await openDatabaseService({ forceMemory: true }));
}

function createPayload(id = 'post-1'): SocialWirePayload {
  return {
    version: 1,
    entity: 'post',
    action: 'upsert',
    post: {
      id,
      author: 'peer-a',
      createdAt: 1,
      updatedAt: 1,
      signature: 'sig',
      version: '2.0.0',
      text: 'hello',
      contentHash: `hash-${id}`,
      mediaAttachments: [],
      deleted: false,
    },
    gossip: {
      version: 1,
      originPeerId: 'peer-a',
      objectId: id,
      ttl: 8,
      path: ['peer-a'],
    },
  };
}

function createPostData(id = 'post-1') {
  const payload = createPayload(id);
  if (payload.entity !== 'post') {
    throw new Error('Expected post payload');
  }
  return payload.post;
}

function createPrivateChatPayload(messageId = 'chat-message-1'): SocialWirePayload {
  const ciphertext = 'ab'.repeat(64);
  return {
    version: 1,
    entity: 'chat',
    action: 'upsert',
    envelope: {
      version: 1,
      type: 'chat.private.envelope',
      algorithm: 'x25519-aes-256-gcm',
      messageId,
      senderId: 'peer-a',
      recipientId: 'peer-d',
      createdAt: 100,
      ciphertext,
      nonce: '01'.repeat(12),
      ciphertextHash: sha256Hex(ciphertext),
      signature: 'cd'.repeat(64),
    },
    gossip: {
      version: 1,
      originPeerId: 'peer-a',
      objectId: messageId,
      ttl: 8,
      path: ['peer-a'],
    },
  };
}

describe('SocialReplicationQueueRepository', () => {
  it('uses the same durable queue id when the gossip route changes', () => {
    const first = createPrivateChatPayload();
    const second: SocialWirePayload = {
      ...first,
      gossip: first.gossip
        ? {
            ...first.gossip,
            ttl: first.gossip.ttl - 1,
            path: [...first.gossip.path, 'peer-b' as PeerId],
          }
        : undefined,
    };

    expect(createQueueItemId(first)).toBe(createQueueItemId(second));
  });

  it('persists pending replication items across repository instances', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    const first = new SocialReplicationQueueRepository(database);
    const payload = createPayload();

    const item = await first.upsertPayload(payload, 100);
    const second = new SocialReplicationQueueRepository(database);

    await expect(second.get(item.id)).resolves.toMatchObject({
      id: createQueueItemId(payload),
      status: 'queued',
      attempts: 0,
      nextAttemptAt: 100,
    });
    await expect(second.listPending(100)).resolves.toHaveLength(1);
  });

  it('tracks peer ACKs, retry failures and final ACK state', async () => {
    const repository = await createRepository();
    const item = await repository.upsertPayload(createPayload(), 100);

    await repository.markSending(item.id, 110);
    await repository.markFailed(
      item.id,
      [{ peerId: 'peer-b', errorCode: 'NETWORK_ERROR' }],
      5000,
      120,
    );

    await expect(repository.get(item.id)).resolves.toMatchObject({
      status: 'failed',
      attempts: 1,
      nextAttemptAt: 5120,
      failedPeers: [{ peerId: 'peer-b', errorCode: 'NETWORK_ERROR', failedAt: 120 }],
    });
    await expect(repository.listPending(5119)).resolves.toHaveLength(0);
    await expect(repository.listPending(5120)).resolves.toHaveLength(1);

    await repository.markPeerAcked(item.id, 'peer-b', 5130);
    await expect(repository.get(item.id)).resolves.toMatchObject({
      status: 'relayed',
      relayPeerIds: ['peer-b'],
      lastReceipt: {
        type: 'relay',
        peerId: 'peer-b',
        receivedAt: 5130,
      },
    });
    await repository.markAcked(item.id, 5140);

    await expect(repository.get(item.id)).resolves.toMatchObject({
      status: 'delivered',
      relayPeerIds: ['peer-b'],
      failedPeers: [],
    });
  });

  it('recovers an expired sending lease without duplicating a live claim', async () => {
    const repository = await createRepository();
    const item = await repository.upsertPayload(createPayload(), 100);

    const claimed = await repository.markSending(item.id, 110, 'lease-a', 100);
    expect(claimed?.leaseId).toBe('lease-a');
    await expect(repository.markSending(item.id, 150, 'lease-b', 100)).resolves.toBeNull();
    await expect(repository.recoverInterrupted(209)).resolves.toBe(0);
    await expect(repository.recoverInterrupted(210)).resolves.toBe(1);
    await expect(repository.get(item.id)).resolves.toMatchObject({ status: 'queued' });
    expect((await repository.get(item.id))?.leaseId).toBeUndefined();
  });

  it('recovers a live sending lease when a new runtime starts after reload', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    const first = new SocialReplicationQueueRepository(database);
    const item = await first.upsertPayload(createPrivateChatPayload(), 100);
    await first.markSending(item.id, 110, 'runtime-before-reload', 30_000);

    const restored = new SocialReplicationQueueRepository(database);
    await expect(restored.recoverInterrupted(120, true)).resolves.toBe(1);
    await expect(restored.get(item.id)).resolves.toMatchObject({
      status: 'queued',
      nextAttemptAt: 120,
    });
    expect((await restored.get(item.id))?.leaseId).toBeUndefined();
  });

  it('grants only one lease to concurrent outbox claimers', async () => {
    const repository = await createRepository();
    const item = await repository.upsertPayload(createPayload(), 100);

    const claims = await Promise.all([
      repository.markSending(item.id, 110, 'lease-a', 1000),
      repository.markSending(item.id, 110, 'lease-b', 1000),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.leaseId).toBe('lease-a');
  });

  it('exposes the next retry time for pending and failed items', async () => {
    const repository = await createRepository();
    const first = await repository.upsertPayload(createPayload('post-a'), 100);
    const second = await repository.upsertPayload(createPayload('post-b'), 200);

    await repository.markSending(first.id, 110);
    await repository.markFailed(
      first.id,
      [{ peerId: 'peer-b', errorCode: 'NETWORK_ERROR' }],
      5000,
      120,
    );

    await expect(repository.getNextAttemptAt(150)).resolves.toBe(200);
    await repository.markAcked(second.id, 210);
    await expect(repository.getNextAttemptAt(150)).resolves.toBe(5120);
    await repository.markAcked(first.id, 5130);
    await expect(repository.getNextAttemptAt(5130)).resolves.toBeNull();
  });

  it('deduplicates an incoming delivery after repository reconstruction', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    const first = new SocialReplicationQueueRepository(database);
    const payload = createPayload();
    const claim = await first.claimIncoming({
      deliveryId: 'delivery-1',
      networkMessageId: 'network-1',
      payload,
      sourcePeerId: 'peer-b',
      now: 100,
    });
    expect(claim.accepted).toBe(true);
    await first.markIncomingApplied('delivery-1', 110);

    const restored = new SocialReplicationQueueRepository(database);
    await expect(
      restored.claimIncoming({
        deliveryId: 'delivery-1',
        networkMessageId: 'network-2',
        payload,
        sourcePeerId: 'peer-b',
        now: 120,
      }),
    ).resolves.toMatchObject({
      accepted: false,
      item: { status: 'applied', networkMessageId: 'network-1' },
    });
  });

  it('clears all delivery records', async () => {
    const repository = await createRepository();
    const item = await repository.upsertPayload(createPayload(), 100);
    await repository.claimIncoming({
      deliveryId: 'delivery-1',
      networkMessageId: 'network-1',
      payload: createPayload(),
      sourcePeerId: 'peer-b',
      now: 100,
    });

    await repository.clear();

    await expect(repository.get(item.id)).resolves.toBeNull();
    await expect(repository.listPending(100)).resolves.toEqual([]);
  });

  it('records a delivery receipt and acknowledges chat outbox atomically', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    const repository = new SocialReplicationQueueRepository(database);
    const item = await repository.upsertPayload(createPrivateChatPayload(), 100);
    const receipt = {
      version: 1 as const,
      type: 'chat.delivery.receipt' as const,
      messageId: 'chat-message-1',
      senderId: 'peer-a' as PeerId,
      recipientId: 'peer-d' as PeerId,
      deliveredAt: 200,
      signature: 'ef'.repeat(64),
    };

    await expect(repository.recordChatDeliveryReceipt(receipt)).resolves.toBe(true);
    await expect(repository.get(item.id)).resolves.toMatchObject({
      status: 'delivered',
      updatedAt: 200,
      lastReceipt: {
        type: 'delivery',
        peerId: 'peer-d',
        receivedAt: 200,
      },
    });

    const restored = new SocialReplicationQueueRepository(database);
    await expect(restored.getChatDeliveryReceipt(receipt.messageId)).resolves.toEqual(receipt);
    await expect(restored.recordChatDeliveryReceipt(receipt)).resolves.toBe(false);
  });

  it('stores signed read receipts independently from delivery receipts', async () => {
    const repository = await createRepository();
    const receipt = {
      version: 1 as const,
      type: 'chat.read.receipt' as const,
      messageId: 'chat-message-1',
      senderId: 'peer-a' as PeerId,
      recipientId: 'peer-d' as PeerId,
      readAt: 250,
      signature: 'ab'.repeat(64),
    };

    await expect(repository.recordChatReceipt(receipt)).resolves.toBe(true);
    await expect(repository.getChatReadReceipt(receipt.messageId)).resolves.toEqual(receipt);
    await expect(repository.recordChatReceipt(receipt)).resolves.toBe(false);
  });

  it('transitions a chat outbox from relay custody through delivered and read receipts', async () => {
    const repository = await createRepository();
    const item = await repository.upsertPayload(createPrivateChatPayload(), 100);
    await repository.markPeerAcked(item.id, 'peer-b' as PeerId, 150);
    await repository.recordChatDeliveryReceipt({
      version: 1,
      type: 'chat.delivery.receipt',
      messageId: 'chat-message-1',
      senderId: 'peer-a' as PeerId,
      recipientId: 'peer-d' as PeerId,
      deliveredAt: 200,
      signature: 'ef'.repeat(64),
    });
    await repository.recordChatReceipt({
      version: 1,
      type: 'chat.read.receipt',
      messageId: 'chat-message-1',
      senderId: 'peer-a' as PeerId,
      recipientId: 'peer-d' as PeerId,
      readAt: 250,
      signature: 'ab'.repeat(64),
    });

    await expect(repository.get(item.id)).resolves.toMatchObject({
      status: 'read',
      relayPeerIds: ['peer-b'],
      lastReceipt: {
        type: 'read',
        peerId: 'peer-d',
        receivedAt: 250,
      },
    });
    await expect(repository.listPending(300)).resolves.toEqual([]);
  });

  it('expires undelivered work and stops returning it for retry', async () => {
    const repository = await createRepository();
    const item = await repository.upsertPayload(createPrivateChatPayload(), 100);
    const expiredAt = 100 + SOCIAL_OUTBOX_DELIVERY_TTL_MS;

    await expect(repository.listPending(expiredAt)).resolves.toEqual([]);
    await expect(repository.get(item.id)).resolves.toMatchObject({
      status: 'expired',
      terminalAt: expiredAt,
      terminalReason: 'DELIVERY_EXPIRED',
    });
    await expect(repository.getNextAttemptAt(expiredAt)).resolves.toBeNull();
  });

  it('moves repeatedly failing work to dead-letter after the attempt limit', async () => {
    const repository = await createRepository();
    const item = await repository.upsertPayload(createPayload('dead-letter-post'), 100);

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const now = 200 + attempt * 10;
      await repository.markSending(item.id, now, `lease-${attempt}`, 1);
      await repository.markFailed(
        item.id,
        [{ peerId: 'peer-b', errorCode: 'NETWORK_ERROR' }],
        0,
        now + 1,
      );
    }

    await expect(repository.get(item.id)).resolves.toMatchObject({
      status: 'dead-letter',
      attempts: 12,
      terminalReason: 'MAX_DELIVERY_ATTEMPTS_EXCEEDED',
    });
    await expect(repository.listPending(1000)).resolves.toEqual([]);
  });

  it('retains expired work for diagnostics while garbage collecting old terminal delivery state', async () => {
    const repository = await createRepository();
    const pending = await repository.upsertPayload(createPayload('pending-post'), 100);
    const acknowledged = await repository.upsertPayload(createPayload('acked-post'), 100);
    await repository.markAcked(acknowledged.id, 200);

    await expect(repository.garbageCollect(8 * 24 * 60 * 60 * 1000)).resolves.toBe(1);
    await expect(repository.get(acknowledged.id)).resolves.toBeNull();
    await expect(repository.get(pending.id)).resolves.toMatchObject({
      status: 'expired',
      terminalReason: 'DELIVERY_EXPIRED',
    });
  });

  it('rejects corrupted persisted records with a typed storage error', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    const repository = new SocialReplicationQueueRepository(database);
    await database.run(
      `INSERT OR REPLACE INTO social_delivery_records
       (id, kind, status, messageId, objectId, nextAttemptAt, expiresAt, updatedAt, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      ['broken', 'outbox', 'pending', null, null, 1, 100, 1, '{broken'],
    );

    await expect(repository.getStatus()).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
      retryable: true,
    });
  });

  it('migrates the legacy localStorage queue only after a successful database commit', async () => {
    const storage = createStorageService(createMemoryDriver());
    const payload = createPayload();
    const id = createQueueItemId(payload);
    storage.setJson('social_replication_queue_v1', {
      [id]: {
        id,
        payload,
        status: 'sending',
        createdAt: 100,
        updatedAt: 120,
        attempts: 1,
        nextAttemptAt: 500,
        ackedPeerIds: [],
        failedPeers: [],
      },
    });
    const repository = await createRepository();

    await expect(repository.migrateLegacyStorage(storage)).resolves.toEqual({
      migratedOutbox: 1,
      migratedReceipts: 0,
      invalidRecords: 0,
    });
    await expect(repository.get(id)).resolves.toMatchObject({
      status: 'queued',
      nextAttemptAt: expect.any(Number),
    });
    expect(storage.getString('social_replication_queue_v1')).toBeNull();
    expect(storage.getString('social_delivery_v2_migrated')).toBe('1');
  });

  it('retains a corrupt legacy source instead of declaring migration complete', async () => {
    const storage = createStorageService(createMemoryDriver());
    storage.setJson('social_replication_queue_v1', {
      broken: { status: 'pending' },
    });
    const repository = await createRepository();

    await expect(repository.migrateLegacyStorage(storage)).resolves.toMatchObject({
      migratedOutbox: 0,
      invalidRecords: 1,
    });
    expect(storage.getJson('social_replication_queue_v1')).not.toBeNull();
    expect(storage.getString('social_delivery_v2_migrated')).toBeNull();
  });
});

describe('SocialReplicationService queue delivery', () => {
  it('does not send queued payloads to authenticated peers without an open connection', async () => {
    const queue = await createRepository();
    const transport = new StalePeerTransport('peer-a' as PeerId, ['peer-b' as PeerId], false);
    const replication = new SocialReplicationService(
      'peer-a' as PeerId,
      () => transport,
      () => ['peer-b' as PeerId],
      queue,
    );

    const result = await replication.replicatePost(createPostData());
    replication.stop();

    expect(result).toEqual({ attemptedPeers: 0, successfulPeers: [], failedPeers: [] });
    expect(transport.sentMessages).toBe(0);
    await expect(queue.getStatus()).resolves.toMatchObject({
      pending: 1,
      sending: 0,
      failed: 0,
      acked: 0,
    });
  });

  it('returns failed queued items to retry state when transport send fails', async () => {
    const queue = await createRepository();
    const transport = new StalePeerTransport('peer-a' as PeerId, ['peer-b' as PeerId], true);
    const replication = new SocialReplicationService(
      'peer-a' as PeerId,
      () => transport,
      () => ['peer-b' as PeerId],
      queue,
    );

    const result = await replication.replicatePost(createPostData());
    replication.stop();

    expect(result.failedPeers).toEqual([{ peerId: 'peer-b', errorCode: 'NETWORK_ERROR' }]);
    await expect(queue.getStatus()).resolves.toMatchObject({
      pending: 0,
      sending: 0,
      failed: 1,
      acked: 0,
    });
  });

  it('selects an untried relay after the first relay already accepted custody', async () => {
    const queue = await createRepository();
    const now = Date.now() - 100;
    const item = await queue.upsertPayload(createPrivateChatPayload(), now);
    await queue.markPeerAcked(item.id, 'peer-b' as PeerId, now + 1);
    await queue.markPending(item.id, 0, now + 2);
    const transport = new AckingPeerTransport('peer-a' as PeerId, [
      'peer-b' as PeerId,
      'peer-c' as PeerId,
    ]);
    const replication = new SocialReplicationService(
      'peer-a' as PeerId,
      () => transport,
      () => transport.getConnectedPeers(),
      queue,
    );
    transport.onMessage = async (message, peerId) => {
      await replication.handleAck(message, peerId);
    };

    const result = await replication.processPendingQueue();
    replication.stop();

    expect(result.attemptedPeers).toBe(1);
    expect(transport.sentPeers).toEqual(['peer-c']);
    await expect(queue.get(item.id)).resolves.toMatchObject({
      status: 'relayed',
      relayPeerIds: ['peer-b', 'peer-c'],
    });
  });
});

class StalePeerTransport implements PeerTransport {
  sentMessages = 0;

  constructor(
    readonly localPeerId: PeerId,
    private readonly peers: PeerId[],
    private readonly hasOpenConnection: boolean,
  ) {}

  async connect(): Promise<PeerConnection> {
    throw new Error('not implemented');
  }

  async disconnect(): Promise<void> {
    return undefined;
  }

  async send(): Promise<void> {
    this.sentMessages += 1;
    throw new AppError({
      code: 'NETWORK_ERROR',
      message: 'Synthetic transport failure',
      safeMessage: 'Falha sintetica de transporte.',
      severity: 'warning',
      retryable: true,
    });
  }

  subscribe(): () => void {
    return () => undefined;
  }

  getConnection(peerId: PeerId): PeerConnection | null {
    if (!this.hasOpenConnection || !this.peers.includes(peerId)) {
      return null;
    }
    return {
      peerId,
      localPeerId: this.localPeerId,
      connectedAt: 1,
      lastSeenAt: 1,
      send: async () => undefined,
    };
  }

  getConnectedPeers(): PeerId[] {
    return [...this.peers];
  }
}

class AckingPeerTransport implements PeerTransport {
  readonly sentPeers: PeerId[] = [];
  onMessage?: (message: NetworkMessage, peerId: PeerId) => Promise<void>;

  constructor(
    readonly localPeerId: PeerId,
    private readonly peers: PeerId[],
  ) {}

  async connect(): Promise<PeerConnection> {
    throw new Error('not implemented');
  }

  async disconnect(): Promise<void> {
    return undefined;
  }

  async send(peerId: PeerId, message: NetworkMessage): Promise<void> {
    this.sentPeers.push(peerId);
    const payload = message.payload;
    if (!message.correlationId || !isSocialWirePayload(payload)) {
      throw new Error('Expected a correlated social payload');
    }
    await this.onMessage?.(
      createNetworkMessage({
        messageType: 'social.ack',
        senderId: peerId,
        correlationId: message.correlationId,
        payload: createSocialAckPayload({
          queueItemId: message.correlationId,
          payload,
          applied: true,
          skipped: false,
          conflict: false,
        }),
      }),
      peerId,
    );
  }

  subscribe(): () => void {
    return () => undefined;
  }

  getConnection(peerId: PeerId): PeerConnection | null {
    if (!this.peers.includes(peerId)) {
      return null;
    }
    return {
      peerId,
      localPeerId: this.localPeerId,
      connectedAt: 1,
      lastSeenAt: 1,
      send: async () => undefined,
    };
  }

  getConnectedPeers(): PeerId[] {
    return [...this.peers];
  }
}

function createMemoryDriver(): StorageDriver {
  const data = new Map<string, string>();
  return {
    getString: (key) => data.get(key) ?? null,
    setString: (key, value) => {
      data.set(key, value);
    },
    remove: (key) => {
      data.delete(key);
    },
    clear: () => {
      data.clear();
    },
  };
}
