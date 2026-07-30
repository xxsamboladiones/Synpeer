import type { DatabaseService } from '@/database/DatabaseService';
import { AppError } from '@/errors/AppError';
import type { PeerId } from '@/network/NetworkTypes';
import { createLogger } from '@/observability/Logger';
import type { StorageService } from '@/services/storage/StorageService';
import { sha256Hex } from '@/utils/hash';

import {
  isChatDeliveryReceipt,
  isChatReadReceipt,
  isChatReceipt,
  type ChatDeliveryReceiptV1,
  type ChatReadReceiptV1,
  type ChatReceiptV1,
} from './PrivateChatProtocol';
import type { SocialWirePayload } from './SocialReplicationService';

const TABLE_NAME = 'social_delivery_records';
const LEGACY_QUEUE_KEY = 'social_replication_queue_v1';
const LEGACY_RECEIPTS_KEY = 'social_chat_delivery_receipts_v1';
const LEGACY_MIGRATION_KEY = 'social_delivery_v2_migrated';
const DEFAULT_LEASE_MS = 30_000;
export const SOCIAL_OUTBOX_DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_INBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_OUTBOX_ATTEMPTS = 12;
const MAX_ROUTE_HISTORY_ENTRIES = 32;

const INSERT_RECORD = `
  INSERT OR REPLACE INTO ${TABLE_NAME}
  (id, kind, status, messageId, objectId, nextAttemptAt, expiresAt, updatedAt, data)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
`;

export type SocialReplicationQueueStatus =
  'queued' | 'sending' | 'relayed' | 'delivered' | 'read' | 'failed' | 'expired' | 'dead-letter';
export type SocialInboxStatus = 'processing' | 'applied' | 'rejected';

export interface SocialReplicationRouteAttempt {
  peerId: PeerId;
  attemptedAt: number;
  outcome: 'relayed' | 'failed';
  errorCode?: string;
}

export interface SocialReplicationReceiptCheckpoint {
  type: 'relay' | 'delivery' | 'read';
  peerId: PeerId;
  receivedAt: number;
  receiptId?: string;
}

export interface SocialReplicationQueueItem {
  version: 3;
  kind: 'outbox';
  id: string;
  payload: SocialWirePayload;
  status: SocialReplicationQueueStatus;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  nextAttemptAt: number;
  relayPeerIds: PeerId[];
  routeHistory: SocialReplicationRouteAttempt[];
  lastReceipt?: SocialReplicationReceiptCheckpoint;
  failedPeers: Array<{ peerId: PeerId; errorCode: string; failedAt: number }>;
  leaseId?: string;
  leaseExpiresAt?: number;
  expiresAt: number;
  terminalAt?: number;
  terminalReason?: string;
}

export interface SocialReplicationQueueSummary {
  pending: number;
  sending: number;
  acked: number;
  failed: number;
  queued: number;
  relayed: number;
  delivered: number;
  read: number;
  expired: number;
  deadLetter: number;
}

export interface SocialInboxItem {
  version: 1;
  kind: 'inbox';
  id: string;
  deliveryId: string;
  networkMessageId: string;
  entity: SocialWirePayload['entity'];
  objectId: string;
  sourcePeerId: PeerId;
  payloadHash: string;
  status: SocialInboxStatus;
  receivedAt: number;
  updatedAt: number;
  expiresAt: number;
  errorCode?: string;
}

export interface SocialReceiptRecord {
  version: 1;
  kind: 'receipt';
  id: string;
  status: 'recorded';
  messageId: string;
  receipt: ChatReceiptV1;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface SocialInboxClaim {
  accepted: boolean;
  item: SocialInboxItem;
}

type SocialDeliveryRecord = SocialReplicationQueueItem | SocialInboxItem | SocialReceiptRecord;

type PersistedRow = {
  id: string;
  kind: SocialDeliveryRecord['kind'];
  status: string;
  messageId: string | null;
  objectId: string | null;
  nextAttemptAt: number | null;
  expiresAt: number;
  updatedAt: number;
  data: string;
};

export class SocialReplicationQueueRepository {
  private readonly logger = createLogger('social.delivery.repository');
  private readonly initialized: Promise<void>;

  constructor(private readonly database: DatabaseService) {
    this.initialized = this.initializeTable();
  }

  async upsertPayload(
    payload: SocialWirePayload,
    now = Date.now(),
  ): Promise<SocialReplicationQueueItem> {
    await this.ensureInitialized();
    return await this.database.transaction(async (transaction) => {
      const id = createQueueItemId(payload);
      const existing = await this.getOutbox(id, transaction);
      const next = normalizeOutboxItem(
        existing
          ? {
              ...existing,
              payload,
              status: isTerminalOutboxStatus(existing.status)
                ? existing.status
                : existing.status === 'relayed'
                  ? 'relayed'
                  : 'queued',
              updatedAt: now,
              leaseId: undefined,
              leaseExpiresAt: undefined,
            }
          : {
              version: 3,
              kind: 'outbox',
              id,
              payload,
              status: 'queued',
              createdAt: now,
              updatedAt: now,
              attempts: 0,
              nextAttemptAt: now,
              relayPeerIds: [],
              routeHistory: [],
              failedPeers: [],
              expiresAt: getPayloadExpiresAt(payload, now),
            },
      );
      await this.writeRecord(next, transaction);
      return next;
    });
  }

  async get(id: string): Promise<SocialReplicationQueueItem | null> {
    await this.ensureInitialized();
    return await this.getOutbox(id, this.database);
  }

  async listPending(now = Date.now()): Promise<SocialReplicationQueueItem[]> {
    await this.ensureInitialized();
    await this.reconcileDeliveryLimits(now);
    return (await this.listOutbox(this.database))
      .filter(
        (item) =>
          (item.status === 'queued' || item.status === 'relayed' || item.status === 'failed') &&
          item.nextAttemptAt <= now,
      )
      .sort(
        (left, right) =>
          left.nextAttemptAt - right.nextAttemptAt || left.createdAt - right.createdAt,
      );
  }

  async getNextAttemptAt(now = Date.now()): Promise<number | null> {
    await this.ensureInitialized();
    await this.reconcileDeliveryLimits(now);
    const pending = (await this.listOutbox(this.database)).filter(
      (item) => item.status === 'queued' || item.status === 'relayed' || item.status === 'failed',
    );
    return pending.length === 0
      ? null
      : Math.min(...pending.map((item) => Math.max(now, item.nextAttemptAt)));
  }

  async markSending(
    id: string,
    now = Date.now(),
    leaseId = createLeaseId(id, now),
    leaseMs = DEFAULT_LEASE_MS,
  ): Promise<SocialReplicationQueueItem | null> {
    return await this.patchOutbox(id, (item) => {
      const limited = applyDeliveryLimits(item, now);
      if (limited.status === 'expired' || limited.status === 'dead-letter') {
        return limited;
      }
      if (
        isTerminalOutboxStatus(item.status) ||
        (item.status === 'sending' && (item.leaseExpiresAt ?? 0) > now)
      ) {
        return null;
      }
      return {
        ...limited,
        status: 'sending',
        attempts: limited.attempts + 1,
        updatedAt: now,
        leaseId,
        leaseExpiresAt: now + Math.max(1, leaseMs),
      };
    });
  }

  async markPeerAcked(
    id: string,
    peerId: PeerId,
    now = Date.now(),
  ): Promise<SocialReplicationQueueItem | null> {
    return await this.patchOutbox(id, (item) => {
      if (isTerminalOutboxStatus(item.status)) {
        return item;
      }
      return {
        ...item,
        status: 'relayed',
        relayPeerIds: Array.from(new Set([...item.relayPeerIds, peerId])),
        routeHistory: appendRouteAttempts(item.routeHistory, [
          { peerId, attemptedAt: now, outcome: 'relayed' },
        ]),
        lastReceipt: {
          type: 'relay',
          peerId,
          receivedAt: now,
        },
        failedPeers: item.failedPeers.filter((peer) => peer.peerId !== peerId),
        updatedAt: now,
        leaseId: undefined,
        leaseExpiresAt: undefined,
      };
    });
  }

  async markFailed(
    id: string,
    failedPeers: Array<{ peerId: PeerId; errorCode: string }>,
    retryDelayMs: number,
    now = Date.now(),
  ): Promise<SocialReplicationQueueItem | null> {
    return await this.patchOutbox(id, (item) => {
      const next = applyDeliveryLimits(
        {
          ...item,
          status: 'failed',
          failedPeers: mergeFailedPeers(item.failedPeers, failedPeers, now),
          routeHistory: appendRouteAttempts(
            item.routeHistory,
            failedPeers.map((peer) => ({
              peerId: peer.peerId,
              attemptedAt: now,
              outcome: 'failed' as const,
              errorCode: peer.errorCode,
            })),
          ),
          nextAttemptAt: now + Math.max(0, retryDelayMs),
          updatedAt: now,
          leaseId: undefined,
          leaseExpiresAt: undefined,
        },
        now,
      );
      return next;
    });
  }

  async markPending(
    id: string,
    retryDelayMs: number,
    now = Date.now(),
  ): Promise<SocialReplicationQueueItem | null> {
    return await this.patchOutbox(id, (item) => {
      if (isTerminalOutboxStatus(item.status)) {
        return item;
      }
      return applyDeliveryLimits(
        {
          ...item,
          status: item.status === 'relayed' ? 'relayed' : 'queued',
          nextAttemptAt: now + Math.max(0, retryDelayMs),
          updatedAt: now,
          leaseId: undefined,
          leaseExpiresAt: undefined,
        },
        now,
      );
    });
  }

  async markAcked(id: string, now = Date.now()): Promise<SocialReplicationQueueItem | null> {
    return await this.markDelivered(id, now);
  }

  async markDelivered(id: string, now = Date.now()): Promise<SocialReplicationQueueItem | null> {
    return await this.patchOutbox(id, (item) => {
      if (item.status === 'expired' || item.status === 'dead-letter') {
        return item;
      }
      return {
        ...item,
        status: item.status === 'read' ? 'read' : 'delivered',
        nextAttemptAt: now,
        updatedAt: now,
        leaseId: undefined,
        leaseExpiresAt: undefined,
        terminalAt: item.terminalAt ?? now,
        terminalReason: undefined,
      };
    });
  }

  async markDeadLetter(
    id: string,
    errorCode: string,
    now = Date.now(),
  ): Promise<SocialReplicationQueueItem | null> {
    return await this.patchOutbox(id, (item) => ({
      ...item,
      status: 'dead-letter',
      nextAttemptAt: now,
      updatedAt: now,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      terminalAt: item.terminalAt ?? now,
      terminalReason: errorCode,
    }));
  }

  async recoverInterrupted(now = Date.now(), includeLiveLeases = false): Promise<number> {
    await this.ensureInitialized();
    return await this.database.transaction(async (transaction) => {
      let recovered = 0;
      for (const item of await this.listOutbox(transaction)) {
        if (item.status !== 'sending' || (!includeLiveLeases && (item.leaseExpiresAt ?? 0) > now)) {
          continue;
        }
        await this.writeRecord(
          {
            ...item,
            status: item.relayPeerIds.length > 0 ? 'relayed' : 'queued',
            nextAttemptAt: now,
            updatedAt: now,
            leaseId: undefined,
            leaseExpiresAt: undefined,
          },
          transaction,
        );
        recovered += 1;
      }
      return recovered;
    });
  }

  async claimIncoming(input: {
    deliveryId: string;
    networkMessageId: string;
    payload: SocialWirePayload;
    sourcePeerId: PeerId;
    now?: number;
    processingLeaseMs?: number;
  }): Promise<SocialInboxClaim> {
    await this.ensureInitialized();
    const now = input.now ?? Date.now();
    const id = createInboxId(input.deliveryId);
    return await this.database.transaction(async (transaction) => {
      const existing = await this.getInbox(id, transaction);
      if (
        existing &&
        (existing.status === 'applied' ||
          existing.status === 'rejected' ||
          now - existing.updatedAt < (input.processingLeaseMs ?? DEFAULT_LEASE_MS))
      ) {
        return { accepted: false, item: existing };
      }
      const item: SocialInboxItem = {
        version: 1,
        kind: 'inbox',
        id,
        deliveryId: input.deliveryId,
        networkMessageId: input.networkMessageId,
        entity: input.payload.entity,
        objectId: getPayloadObjectId(input.payload),
        sourcePeerId: input.sourcePeerId,
        payloadHash: sha256Hex(JSON.stringify(input.payload)),
        status: 'processing',
        receivedAt: existing?.receivedAt ?? now,
        updatedAt: now,
        expiresAt: now + DEFAULT_INBOX_RETENTION_MS,
      };
      await this.writeRecord(item, transaction);
      return { accepted: true, item };
    });
  }

  async markIncomingApplied(deliveryId: string, now = Date.now()): Promise<boolean> {
    return await this.patchInbox(createInboxId(deliveryId), (item) => ({
      ...item,
      status: 'applied',
      updatedAt: now,
      errorCode: undefined,
    }));
  }

  async markIncomingRejected(
    deliveryId: string,
    errorCode: string,
    now = Date.now(),
  ): Promise<boolean> {
    return await this.patchInbox(createInboxId(deliveryId), (item) => ({
      ...item,
      status: 'rejected',
      updatedAt: now,
      errorCode,
    }));
  }

  async recordChatReceipt(receipt: ChatReceiptV1): Promise<boolean> {
    await this.ensureInitialized();
    return await this.database.transaction(async (transaction) => {
      const id = createReceiptId(receipt);
      const existing = await this.getReceipt(id, transaction);
      const timestamp =
        receipt.type === 'chat.delivery.receipt' ? receipt.deliveredAt : receipt.readAt;
      if (!existing) {
        const record: SocialReceiptRecord = {
          version: 1,
          kind: 'receipt',
          id,
          status: 'recorded',
          messageId: receipt.messageId,
          receipt,
          createdAt: timestamp,
          updatedAt: timestamp,
          expiresAt: timestamp + DEFAULT_INBOX_RETENTION_MS,
        };
        await this.writeRecord(record, transaction);
      }
      await this.applyReceiptToOutbox(receipt, id, transaction);
      return !existing;
    });
  }

  async recordChatDeliveryReceipt(receipt: ChatDeliveryReceiptV1): Promise<boolean> {
    return await this.recordChatReceipt(receipt);
  }

  async markChatDelivered(messageId: string, deliveredAt = Date.now()): Promise<number> {
    await this.ensureInitialized();
    return await this.database.transaction(async (transaction) => {
      let updated = 0;
      for (const item of await this.listOutbox(transaction)) {
        if (
          getChatMessageId(item.payload) !== messageId ||
          item.status === 'delivered' ||
          item.status === 'read'
        ) {
          continue;
        }
        await this.writeRecord(
          {
            ...item,
            status: 'delivered',
            nextAttemptAt: deliveredAt,
            updatedAt: deliveredAt,
            leaseId: undefined,
            leaseExpiresAt: undefined,
            terminalAt: item.terminalAt ?? deliveredAt,
          },
          transaction,
        );
        updated += 1;
      }
      return updated;
    });
  }

  async getChatDeliveryReceipt(messageId: string): Promise<ChatDeliveryReceiptV1 | null> {
    return await this.findReceipt(messageId, isChatDeliveryReceipt);
  }

  async getChatReadReceipt(messageId: string): Promise<ChatReadReceiptV1 | null> {
    return await this.findReceipt(messageId, isChatReadReceipt);
  }

  async listChatReceipts(): Promise<ChatReceiptV1[]> {
    await this.ensureInitialized();
    return (await this.listRecords(this.database))
      .filter((record): record is SocialReceiptRecord => record.kind === 'receipt')
      .map((record) => record.receipt)
      .sort((left, right) => getReceiptTimestamp(left) - getReceiptTimestamp(right));
  }

  async getStatus(): Promise<SocialReplicationQueueSummary> {
    await this.ensureInitialized();
    const items = await this.listOutbox(this.database);
    const queued = items.filter((item) => item.status === 'queued').length;
    const relayed = items.filter((item) => item.status === 'relayed').length;
    const delivered = items.filter((item) => item.status === 'delivered').length;
    const read = items.filter((item) => item.status === 'read').length;
    const expired = items.filter((item) => item.status === 'expired').length;
    const deadLetter = items.filter((item) => item.status === 'dead-letter').length;
    const retryableFailures = items.filter((item) => item.status === 'failed').length;
    return {
      pending: queued + relayed,
      sending: items.filter((item) => item.status === 'sending').length,
      acked: delivered + read,
      failed: retryableFailures + expired + deadLetter,
      queued,
      relayed,
      delivered,
      read,
      expired,
      deadLetter,
    };
  }

  async clearAcked(maxAgeMs: number, now = Date.now()): Promise<number> {
    return await this.deleteMatching(
      (record) =>
        record.kind === 'outbox' &&
        (record.status === 'delivered' || record.status === 'read') &&
        now - (record.terminalAt ?? record.updatedAt) > maxAgeMs,
    );
  }

  async garbageCollect(now = Date.now()): Promise<number> {
    await this.reconcileDeliveryLimits(now);
    return await this.deleteMatching((record) =>
      record.kind === 'outbox'
        ? isTerminalOutboxStatus(record.status) &&
          now - (record.terminalAt ?? record.updatedAt) > DEFAULT_TERMINAL_RETENTION_MS
        : record.expiresAt <= now,
    );
  }

  async clear(): Promise<void> {
    await this.ensureInitialized();
    await this.database.run(`DELETE FROM ${TABLE_NAME} WHERE kind = ?;`, ['outbox']);
    await this.database.run(`DELETE FROM ${TABLE_NAME} WHERE kind = ?;`, ['inbox']);
    await this.database.run(`DELETE FROM ${TABLE_NAME} WHERE kind = ?;`, ['receipt']);
  }

  async migrateLegacyStorage(storage: StorageService): Promise<{
    migratedOutbox: number;
    migratedReceipts: number;
    invalidRecords: number;
  }> {
    await this.ensureInitialized();
    if (storage.getString(LEGACY_MIGRATION_KEY) === '1') {
      return { migratedOutbox: 0, migratedReceipts: 0, invalidRecords: 0 };
    }
    const legacyQueue = storage.getJson<unknown>(LEGACY_QUEUE_KEY);
    const legacyReceipts = storage.getJson<unknown>(LEGACY_RECEIPTS_KEY);
    const queueItems = readLegacyQueue(legacyQueue);
    const receipts = readLegacyReceipts(legacyReceipts);
    const invalidRecords =
      countLegacyValues(legacyQueue) -
      queueItems.length +
      countLegacyValues(legacyReceipts) -
      receipts.length;

    await this.database.transaction(async (transaction) => {
      for (const item of queueItems) {
        const migrated = normalizeOutboxItem({
          ...item,
          version: 3,
          kind: 'outbox',
          status: migrateLegacyQueueStatus(item.status),
          nextAttemptAt:
            item.status === 'sending'
              ? Math.min(item.nextAttemptAt, Date.now())
              : item.nextAttemptAt,
          relayPeerIds: item.ackedPeerIds,
          routeHistory: [],
          leaseId: undefined,
          leaseExpiresAt: undefined,
          expiresAt: item.updatedAt + SOCIAL_OUTBOX_DELIVERY_TTL_MS,
          terminalAt: item.status === 'acked' ? item.updatedAt : undefined,
        });
        await this.writeRecord(migrated, transaction);
      }
      for (const receipt of receipts) {
        const timestamp = receipt.deliveredAt;
        await this.writeRecord(
          {
            version: 1,
            kind: 'receipt',
            id: createReceiptId(receipt),
            status: 'recorded',
            messageId: receipt.messageId,
            receipt,
            createdAt: timestamp,
            updatedAt: timestamp,
            expiresAt: timestamp + DEFAULT_INBOX_RETENTION_MS,
          },
          transaction,
        );
      }
    });

    if (invalidRecords === 0) {
      storage.remove(LEGACY_QUEUE_KEY);
      storage.remove(LEGACY_RECEIPTS_KEY);
      storage.setString(LEGACY_MIGRATION_KEY, '1');
    } else {
      this.logger.warn('legacy_delivery_migration_kept_source', { invalidRecords });
    }
    return {
      migratedOutbox: queueItems.length,
      migratedReceipts: receipts.length,
      invalidRecords,
    };
  }

  private async applyReceiptToOutbox(
    receipt: ChatReceiptV1,
    receiptId: string,
    database: DatabaseService,
  ): Promise<void> {
    const timestamp =
      receipt.type === 'chat.delivery.receipt' ? receipt.deliveredAt : receipt.readAt;
    for (const item of await this.listOutbox(database)) {
      if (getChatMessageId(item.payload) !== receipt.messageId) {
        continue;
      }
      if (
        receipt.type === 'chat.delivery.receipt' &&
        (item.status === 'delivered' || item.status === 'read')
      ) {
        continue;
      }
      if (item.status === 'expired' || item.status === 'dead-letter') {
        continue;
      }
      if (receipt.type === 'chat.read.receipt' && item.status === 'read') {
        continue;
      }
      await this.writeRecord(
        {
          ...item,
          status: receipt.type === 'chat.delivery.receipt' ? 'delivered' : 'read',
          nextAttemptAt: timestamp,
          updatedAt: timestamp,
          leaseId: undefined,
          leaseExpiresAt: undefined,
          terminalAt: item.terminalAt ?? timestamp,
          terminalReason: undefined,
          lastReceipt: {
            type: receipt.type === 'chat.delivery.receipt' ? 'delivery' : 'read',
            peerId: receipt.recipientId,
            receivedAt: timestamp,
            receiptId,
          },
        },
        database,
      );
    }
  }

  private async reconcileDeliveryLimits(now: number): Promise<number> {
    await this.ensureInitialized();
    return await this.database.transaction(async (transaction) => {
      let updated = 0;
      for (const item of await this.listOutbox(transaction)) {
        const limited = applyDeliveryLimits(item, now);
        if (limited === item) {
          continue;
        }
        await this.writeRecord(limited, transaction);
        updated += 1;
      }
      return updated;
    });
  }

  private async initializeTable(): Promise<void> {
    await this.database.execute(`
      CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        messageId TEXT,
        objectId TEXT,
        nextAttemptAt INTEGER,
        expiresAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    await this.database.execute(
      `CREATE INDEX IF NOT EXISTS idx_social_delivery_kind_status ON ${TABLE_NAME}(kind, status);`,
    );
    await this.database.execute(
      `CREATE INDEX IF NOT EXISTS idx_social_delivery_next_attempt ON ${TABLE_NAME}(nextAttemptAt);`,
    );
    await this.database.execute(
      `CREATE INDEX IF NOT EXISTS idx_social_delivery_expiry ON ${TABLE_NAME}(expiresAt);`,
    );
  }

  private async patchOutbox(
    id: string,
    patch: (item: SocialReplicationQueueItem) => SocialReplicationQueueItem | null,
  ): Promise<SocialReplicationQueueItem | null> {
    await this.ensureInitialized();
    return await this.database.transaction(async (transaction) => {
      const existing = await this.getOutbox(id, transaction);
      if (!existing) {
        return null;
      }
      const patched = patch(existing);
      if (!patched) {
        return null;
      }
      const normalized = normalizeOutboxItem(patched);
      await this.writeRecord(normalized, transaction);
      return normalized;
    });
  }

  private async patchInbox(
    id: string,
    patch: (item: SocialInboxItem) => SocialInboxItem,
  ): Promise<boolean> {
    await this.ensureInitialized();
    return await this.database.transaction(async (transaction) => {
      const existing = await this.getInbox(id, transaction);
      if (!existing) {
        return false;
      }
      await this.writeRecord(patch(existing), transaction);
      return true;
    });
  }

  private async getOutbox(
    id: string,
    database: DatabaseService,
  ): Promise<SocialReplicationQueueItem | null> {
    const record = await this.getRecord(id, database);
    return record?.kind === 'outbox' ? record : null;
  }

  private async getInbox(id: string, database: DatabaseService): Promise<SocialInboxItem | null> {
    const record = await this.getRecord(id, database);
    return record?.kind === 'inbox' ? record : null;
  }

  private async getReceipt(
    id: string,
    database: DatabaseService,
  ): Promise<SocialReceiptRecord | null> {
    const record = await this.getRecord(id, database);
    return record?.kind === 'receipt' ? record : null;
  }

  private async getRecord(
    id: string,
    database: DatabaseService,
  ): Promise<SocialDeliveryRecord | null> {
    const rows = await database.query(`SELECT * FROM ${TABLE_NAME} WHERE id = ?;`, [id]);
    return rows.length > 0 ? parseRecord(rows[0]) : null;
  }

  private async listOutbox(database: DatabaseService): Promise<SocialReplicationQueueItem[]> {
    const records = await this.listRecords(database);
    return records.filter(
      (record): record is SocialReplicationQueueItem => record.kind === 'outbox',
    );
  }

  private async listRecords(database: DatabaseService): Promise<SocialDeliveryRecord[]> {
    const rows = await database.query(`SELECT * FROM ${TABLE_NAME};`);
    const records: SocialDeliveryRecord[] = [];
    for (const row of rows) {
      const parsed = parseRecord(row);
      if (parsed) {
        records.push(parsed);
      }
    }
    return records;
  }

  private async writeRecord(
    record: SocialDeliveryRecord,
    database: DatabaseService,
  ): Promise<void> {
    const messageId =
      record.kind === 'receipt'
        ? record.messageId
        : record.kind === 'outbox'
          ? getChatMessageId(record.payload)
          : record.networkMessageId;
    const objectId =
      record.kind === 'outbox'
        ? getPayloadObjectId(record.payload)
        : record.kind === 'inbox'
          ? record.objectId
          : record.messageId;
    await database.run(INSERT_RECORD, [
      record.id,
      record.kind,
      record.status,
      messageId,
      objectId,
      record.kind === 'outbox' ? record.nextAttemptAt : null,
      record.expiresAt,
      record.updatedAt,
      JSON.stringify(record),
    ]);
  }

  private async findReceipt<T extends ChatReceiptV1>(
    messageId: string,
    guard: (value: unknown) => value is T,
  ): Promise<T | null> {
    await this.ensureInitialized();
    for (const record of await this.listRecords(this.database)) {
      if (record.kind === 'receipt' && record.messageId === messageId && guard(record.receipt)) {
        return record.receipt;
      }
    }
    return null;
  }

  private async deleteMatching(
    predicate: (record: SocialDeliveryRecord) => boolean,
  ): Promise<number> {
    await this.ensureInitialized();
    return await this.database.transaction(async (transaction) => {
      let deleted = 0;
      for (const record of await this.listRecords(transaction)) {
        if (!predicate(record)) {
          continue;
        }
        await transaction.run(`DELETE FROM ${TABLE_NAME} WHERE id = ?;`, [record.id]);
        deleted += 1;
      }
      return deleted;
    });
  }

  private async ensureInitialized(): Promise<void> {
    await this.initialized;
  }
}

export function createQueueItemId(payload: SocialWirePayload): string {
  return `social_replication_${getPayloadObjectId(payload)}_${sha256Hex(
    JSON.stringify({ ...payload, gossip: undefined }),
  )}`;
}

function createInboxId(deliveryId: string): string {
  return `social_inbox_${sha256Hex(deliveryId)}`;
}

function createReceiptId(receipt: ChatReceiptV1): string {
  return `social_receipt_${receipt.type}_${receipt.messageId}_${receipt.recipientId}`;
}

function getReceiptTimestamp(receipt: ChatReceiptV1): number {
  return receipt.type === 'chat.delivery.receipt' ? receipt.deliveredAt : receipt.readAt;
}

function createLeaseId(id: string, now: number): string {
  return `lease_${sha256Hex(`${id}:${now}`)}`;
}

function getPayloadObjectId(payload: SocialWirePayload): string {
  if (payload.entity === 'post') {
    return payload.post.id;
  }
  if (payload.entity === 'profile') {
    return payload.profile.id;
  }
  if (payload.entity === 'comment') {
    return payload.comment.id;
  }
  if (payload.entity === 'reaction') {
    return payload.reaction.id;
  }
  if (payload.entity === 'chat') {
    return 'envelope' in payload ? payload.envelope.messageId : payload.chat.id;
  }
  if (payload.entity === 'chat-receipt') {
    return `receipt_${payload.receipt.messageId}_${payload.receipt.recipientId}`;
  }
  return payload.follow.id;
}

function getChatMessageId(payload: SocialWirePayload): string | null {
  if (payload.entity !== 'chat') {
    return null;
  }
  return 'envelope' in payload ? payload.envelope.messageId : payload.chat.id;
}

function normalizeOutboxItem(item: SocialReplicationQueueItem): SocialReplicationQueueItem {
  return {
    ...item,
    relayPeerIds: Array.from(new Set(item.relayPeerIds)),
    routeHistory: item.routeHistory.slice(-MAX_ROUTE_HISTORY_ENTRIES),
    failedPeers: mergeFailedPeers([], item.failedPeers, item.updatedAt),
  };
}

function getPayloadExpiresAt(payload: SocialWirePayload, now: number): number {
  return payload.gossip?.expiresAt && payload.gossip.expiresAt > now
    ? payload.gossip.expiresAt
    : now + SOCIAL_OUTBOX_DELIVERY_TTL_MS;
}

function appendRouteAttempts(
  current: SocialReplicationRouteAttempt[],
  next: SocialReplicationRouteAttempt[],
): SocialReplicationRouteAttempt[] {
  return [...current, ...next].slice(-MAX_ROUTE_HISTORY_ENTRIES);
}

function applyDeliveryLimits(
  item: SocialReplicationQueueItem,
  now: number,
): SocialReplicationQueueItem {
  if (isTerminalOutboxStatus(item.status)) {
    return item;
  }
  if (item.expiresAt <= now) {
    return {
      ...item,
      status: 'expired',
      nextAttemptAt: now,
      updatedAt: now,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      terminalAt: now,
      terminalReason: 'DELIVERY_EXPIRED',
    };
  }
  if (item.attempts >= DEFAULT_MAX_OUTBOX_ATTEMPTS && item.status !== 'sending') {
    return {
      ...item,
      status: 'dead-letter',
      nextAttemptAt: now,
      updatedAt: now,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      terminalAt: now,
      terminalReason: 'MAX_DELIVERY_ATTEMPTS_EXCEEDED',
    };
  }
  return item;
}

function mergeFailedPeers(
  current: Array<{ peerId: PeerId; errorCode: string; failedAt: number }>,
  next: Array<{ peerId: PeerId; errorCode: string; failedAt?: number }>,
  now: number,
): Array<{ peerId: PeerId; errorCode: string; failedAt: number }> {
  const merged = new Map<PeerId, { peerId: PeerId; errorCode: string; failedAt: number }>();
  for (const peer of current) {
    merged.set(peer.peerId, peer);
  }
  for (const peer of next) {
    merged.set(peer.peerId, {
      peerId: peer.peerId,
      errorCode: peer.errorCode,
      failedAt: peer.failedAt ?? now,
    });
  }
  return Array.from(merged.values());
}

function parseRecord(row: unknown): SocialDeliveryRecord | null {
  if (!isPersistedRow(row)) {
    throw createDeliveryStorageError('Social delivery row has an invalid schema');
  }
  try {
    const parsed: unknown = JSON.parse(row.data);
    if (isOutboxItem(parsed)) {
      return normalizeOutboxItem(parsed);
    }
    if (isLegacyOutboxItem(parsed)) {
      return migratePersistedOutboxItem(parsed);
    }
    if (isInboxItem(parsed) || isReceiptRecord(parsed)) {
      return parsed;
    }
  } catch (error) {
    throw createDeliveryStorageError('Social delivery row contains invalid JSON', error);
  }
  throw createDeliveryStorageError('Social delivery record failed runtime validation');
}

function isPersistedRow(value: unknown): value is PersistedRow {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.kind === 'outbox' || value.kind === 'inbox' || value.kind === 'receipt') &&
    typeof value.status === 'string' &&
    typeof value.expiresAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    typeof value.data === 'string'
  );
}

function isOutboxItem(value: unknown): value is SocialReplicationQueueItem {
  return (
    isRecord(value) &&
    value.version === 3 &&
    value.kind === 'outbox' &&
    typeof value.id === 'string' &&
    isSocialWirePayloadRecord(value.payload) &&
    isQueueStatus(value.status) &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.updatedAt) &&
    isFiniteNumber(value.attempts) &&
    isFiniteNumber(value.nextAttemptAt) &&
    isFiniteNumber(value.expiresAt) &&
    (value.leaseId === undefined || typeof value.leaseId === 'string') &&
    (value.leaseExpiresAt === undefined || isFiniteNumber(value.leaseExpiresAt)) &&
    Array.isArray(value.relayPeerIds) &&
    value.relayPeerIds.every((peerId) => typeof peerId === 'string') &&
    Array.isArray(value.routeHistory) &&
    value.routeHistory.every(isRouteAttempt) &&
    (value.lastReceipt === undefined || isReceiptCheckpoint(value.lastReceipt)) &&
    Array.isArray(value.failedPeers) &&
    value.failedPeers.every(isFailedPeer) &&
    (value.terminalAt === undefined || isFiniteNumber(value.terminalAt)) &&
    (value.terminalReason === undefined || typeof value.terminalReason === 'string')
  );
}

type LegacyOutboxItem = {
  version: 2;
  kind: 'outbox';
  id: string;
  payload: SocialWirePayload;
  status: 'pending' | 'sending' | 'acked' | 'failed';
  createdAt: number;
  updatedAt: number;
  attempts: number;
  nextAttemptAt: number;
  ackedPeerIds: PeerId[];
  failedPeers: Array<{ peerId: PeerId; errorCode: string; failedAt: number }>;
  leaseId?: string;
  leaseExpiresAt?: number;
  expiresAt: number;
};

function isLegacyOutboxItem(value: unknown): value is LegacyOutboxItem {
  return (
    isRecord(value) &&
    value.version === 2 &&
    value.kind === 'outbox' &&
    typeof value.id === 'string' &&
    isSocialWirePayloadRecord(value.payload) &&
    isLegacyQueueStatus(value.status) &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.updatedAt) &&
    isFiniteNumber(value.attempts) &&
    isFiniteNumber(value.nextAttemptAt) &&
    isFiniteNumber(value.expiresAt) &&
    (value.leaseId === undefined || typeof value.leaseId === 'string') &&
    (value.leaseExpiresAt === undefined || isFiniteNumber(value.leaseExpiresAt)) &&
    Array.isArray(value.ackedPeerIds) &&
    value.ackedPeerIds.every((peerId) => typeof peerId === 'string') &&
    Array.isArray(value.failedPeers) &&
    value.failedPeers.every(isFailedPeer)
  );
}

function migratePersistedOutboxItem(item: LegacyOutboxItem): SocialReplicationQueueItem {
  return normalizeOutboxItem({
    version: 3,
    kind: 'outbox',
    id: item.id,
    payload: item.payload,
    status: migrateLegacyQueueStatus(item.status),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    attempts: item.attempts,
    nextAttemptAt: item.nextAttemptAt,
    relayPeerIds: item.ackedPeerIds,
    routeHistory: [],
    failedPeers: item.failedPeers,
    leaseId: item.leaseId,
    leaseExpiresAt: item.leaseExpiresAt,
    expiresAt: item.expiresAt,
    terminalAt: item.status === 'acked' ? item.updatedAt : undefined,
  });
}

function isInboxItem(value: unknown): value is SocialInboxItem {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.kind === 'inbox' &&
    typeof value.id === 'string' &&
    typeof value.deliveryId === 'string' &&
    typeof value.networkMessageId === 'string' &&
    typeof value.entity === 'string' &&
    typeof value.objectId === 'string' &&
    typeof value.sourcePeerId === 'string' &&
    typeof value.payloadHash === 'string' &&
    isInboxStatus(value.status) &&
    isFiniteNumber(value.receivedAt) &&
    isFiniteNumber(value.updatedAt) &&
    isFiniteNumber(value.expiresAt) &&
    (value.errorCode === undefined || typeof value.errorCode === 'string')
  );
}

function isReceiptRecord(value: unknown): value is SocialReceiptRecord {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.kind === 'receipt' &&
    value.status === 'recorded' &&
    typeof value.id === 'string' &&
    typeof value.messageId === 'string' &&
    isChatReceipt(value.receipt) &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.updatedAt) &&
    isFiniteNumber(value.expiresAt)
  );
}

function readLegacyQueue(
  value: unknown,
): Array<Omit<LegacyOutboxItem, 'version' | 'kind' | 'expiresAt'>> {
  if (!isRecord(value)) {
    return [];
  }
  const items: Array<Omit<LegacyOutboxItem, 'version' | 'kind' | 'expiresAt'>> = [];
  for (const [id, item] of Object.entries(value)) {
    if (
      isRecord(item) &&
      item.id === id &&
      isSocialWirePayloadRecord(item.payload) &&
      isLegacyQueueStatus(item.status) &&
      isFiniteNumber(item.createdAt) &&
      isFiniteNumber(item.updatedAt) &&
      isFiniteNumber(item.attempts) &&
      isFiniteNumber(item.nextAttemptAt) &&
      Array.isArray(item.ackedPeerIds) &&
      item.ackedPeerIds.every((peerId) => typeof peerId === 'string') &&
      Array.isArray(item.failedPeers) &&
      item.failedPeers.every(isFailedPeer)
    ) {
      items.push({
        id,
        payload: item.payload,
        status: item.status,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        attempts: item.attempts,
        nextAttemptAt: item.nextAttemptAt,
        ackedPeerIds: item.ackedPeerIds,
        failedPeers: item.failedPeers,
        leaseId: undefined,
        leaseExpiresAt: undefined,
      });
    }
  }
  return items;
}

function readLegacyReceipts(value: unknown): ChatDeliveryReceiptV1[] {
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value)
    .filter(
      ([messageId, receipt]) => isChatDeliveryReceipt(receipt) && receipt.messageId === messageId,
    )
    .map(([, receipt]) => receipt as ChatDeliveryReceiptV1);
}

function countLegacyValues(value: unknown): number {
  return isRecord(value) ? Object.keys(value).length : 0;
}

function isSocialWirePayloadRecord(value: unknown): value is SocialWirePayload {
  return isRecord(value) && value.version === 1 && value.action === 'upsert';
}

function isQueueStatus(value: unknown): value is SocialReplicationQueueStatus {
  return (
    value === 'queued' ||
    value === 'sending' ||
    value === 'relayed' ||
    value === 'delivered' ||
    value === 'read' ||
    value === 'failed' ||
    value === 'expired' ||
    value === 'dead-letter'
  );
}

function isLegacyQueueStatus(value: unknown): value is LegacyOutboxItem['status'] {
  return value === 'pending' || value === 'sending' || value === 'acked' || value === 'failed';
}

function migrateLegacyQueueStatus(
  status: LegacyOutboxItem['status'],
): SocialReplicationQueueStatus {
  if (status === 'pending' || status === 'sending') {
    return 'queued';
  }
  if (status === 'acked') {
    return 'delivered';
  }
  return status;
}

function isTerminalOutboxStatus(status: SocialReplicationQueueStatus): boolean {
  return (
    status === 'delivered' || status === 'read' || status === 'expired' || status === 'dead-letter'
  );
}

function isRouteAttempt(value: unknown): value is SocialReplicationRouteAttempt {
  return (
    isRecord(value) &&
    typeof value.peerId === 'string' &&
    isFiniteNumber(value.attemptedAt) &&
    (value.outcome === 'relayed' || value.outcome === 'failed') &&
    (value.errorCode === undefined || typeof value.errorCode === 'string')
  );
}

function isReceiptCheckpoint(value: unknown): value is SocialReplicationReceiptCheckpoint {
  return (
    isRecord(value) &&
    (value.type === 'relay' || value.type === 'delivery' || value.type === 'read') &&
    typeof value.peerId === 'string' &&
    isFiniteNumber(value.receivedAt) &&
    (value.receiptId === undefined || typeof value.receiptId === 'string')
  );
}

function isInboxStatus(value: unknown): value is SocialInboxStatus {
  return value === 'processing' || value === 'applied' || value === 'rejected';
}

function isFailedPeer(
  value: unknown,
): value is { peerId: PeerId; errorCode: string; failedAt: number } {
  return (
    isRecord(value) &&
    typeof value.peerId === 'string' &&
    typeof value.errorCode === 'string' &&
    isFiniteNumber(value.failedAt)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createDeliveryStorageError(message: string, cause?: unknown): AppError {
  return new AppError({
    code: 'STORAGE_ERROR',
    message,
    safeMessage: 'Nao foi possivel atualizar a fila local de entrega.',
    cause,
    severity: 'error',
    retryable: true,
    context: { scope: 'social.delivery.repository' },
  });
}
