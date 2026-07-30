import { AppError } from '@/errors/AppError';
import {
  createNetworkMessage,
  MAX_NETWORK_MESSAGE_BYTES,
  type NetworkMessage,
} from '@/network/NetworkMessage';
import type { PeerConnection, PeerTransport } from '@/network/PeerTransport';
import type { PeerId } from '@/network/NetworkTypes';
import { createLogger } from '@/observability/Logger';
import type { TrustedPeerRepository } from '@/services/peers/TrustedPeerRepository';

import {
  IncrementalSyncService,
  SYNC_ENTITIES,
  type EntitySyncManifest,
  type IncrementalSyncBatch,
  type IncrementalSyncManifest,
  type IncrementalSyncResult,
  type SyncEntity,
} from './IncrementalSyncService';

interface LegacyManifestRequest {
  version: 1;
  type: 'sync.manifest.request';
  cursor?: string;
}

interface LegacyManifestResponse {
  version: 1;
  type: 'sync.manifest.response';
  manifest: IncrementalSyncManifest;
}

interface LegacyBatchRequest {
  version: 1;
  type: 'sync.batch.request';
  cursor?: string;
}

interface EntityManifestRequest {
  version: 2;
  type: 'sync.manifest.request';
  entity: SyncEntity;
  cursor?: string;
}

interface EntityManifestResponse {
  version: 2;
  type: 'sync.manifest.response';
  manifest: EntitySyncManifest;
}

interface EntityBatchRequest {
  version: 2;
  type: 'sync.batch.request';
  entity: SyncEntity;
  itemIds: string[];
}

interface SyncBatchResponse {
  version: 1 | 2;
  type: 'sync.batch.response';
  batch: IncrementalSyncBatch;
}

interface SyncRefreshHint {
  version: 1;
  type: 'sync.refresh.hint';
  changedAt: number;
}

type SyncRequestPayload =
  LegacyManifestRequest | LegacyBatchRequest | EntityManifestRequest | EntityBatchRequest;
type SyncResponsePayload = LegacyManifestResponse | EntityManifestResponse | SyncBatchResponse;

export interface PeerIncrementalSyncProtocolOptions {
  onRefreshRequested?: (peerId: PeerId) => void | Promise<void>;
}

interface PendingSyncRequest {
  resolve(result: SyncResponsePayload): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof globalThis.setTimeout>;
}

export class PeerIncrementalSyncProtocol {
  private static readonly MAX_SYNC_PAGES = 100;
  private static readonly REQUEST_TIMEOUT_MS = 15000;
  private readonly logger = createLogger('PeerIncrementalSyncProtocol');
  private unsubscribe: (() => void) | null = null;
  private pending = new Map<string, PendingSyncRequest>();
  private syncsInFlight = new Map<PeerId, Promise<IncrementalSyncResult>>();
  private resyncRequested = new Set<PeerId>();
  private requestSequence = 0;

  constructor(
    private readonly transport: PeerTransport,
    private readonly syncService: IncrementalSyncService,
    private readonly trustedPeers: TrustedPeerRepository,
    private readonly options: PeerIncrementalSyncProtocolOptions = {},
  ) {}

  start(): void {
    if (this.unsubscribe) {
      return;
    }
    this.unsubscribe = this.transport.subscribe((message, connection) => {
      void this.handleMessage(message, connection).catch((error: unknown) => {
        this.logger.warn('sync_message_handling_failed', {
          peerId: connection.peerId,
          message: error instanceof Error ? error.message : 'unknown',
        });
      });
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const [correlationId, request] of this.pending.entries()) {
      globalThis.clearTimeout(request.timeout);
      request.reject(createSyncError('Incremental sync protocol stopped', correlationId));
    }
    this.pending.clear();
    this.syncsInFlight.clear();
    this.resyncRequested.clear();
  }

  async syncPeer(peerId: PeerId): Promise<IncrementalSyncResult> {
    const existing = this.syncsInFlight.get(peerId);
    if (existing) {
      this.resyncRequested.add(peerId);
      return await existing;
    }
    const operation = this.performRequestedSyncs(peerId).finally(() => {
      if (this.syncsInFlight.get(peerId) === operation) {
        this.syncsInFlight.delete(peerId);
      }
    });
    this.syncsInFlight.set(peerId, operation);
    return await operation;
  }

  async notifyPeerOfChanges(peerId: PeerId, changedAt = Date.now()): Promise<void> {
    const peer = this.trustedPeers.get(peerId);
    const connection = this.transport.getConnection(peerId);
    if (!peer || peer.trustStatus !== 'verified' || !connection) {
      return;
    }
    await connection.send('sync.hint', {
      version: 1,
      type: 'sync.refresh.hint',
      changedAt,
    } satisfies SyncRefreshHint);
  }

  private async performRequestedSyncs(peerId: PeerId): Promise<IncrementalSyncResult> {
    let aggregate = emptySyncResult();
    do {
      this.resyncRequested.delete(peerId);
      aggregate = mergeSyncResults(aggregate, await this.performSyncPeer(peerId));
    } while (this.resyncRequested.delete(peerId));
    return aggregate;
  }

  private async performSyncPeer(peerId: PeerId): Promise<IncrementalSyncResult> {
    const peer = this.trustedPeers.get(peerId);
    if (!peer || peer.trustStatus !== 'verified') {
      return emptySyncResult();
    }
    const connection = this.transport.getConnection(peerId);
    if (!connection) {
      throw createSyncError(`Peer ${peerId} is not connected`, `sync:${peerId}`);
    }

    const checkpoints = this.syncService.getCheckpointRepository();
    if (!checkpoints) {
      return await this.syncPeerLegacy(connection, peer.syncCursor);
    }

    let aggregate = emptySyncResult();
    for (const entity of SYNC_ENTITIES) {
      const result = await this.syncEntity(connection, entity);
      aggregate = mergeSyncResults(aggregate, result);
    }
    this.trustedPeers.recordSync(peerId, aggregate.applied);
    return { ...aggregate, hasMore: false };
  }

  private async syncPeerLegacy(
    connection: PeerConnection,
    initialCursor?: string,
  ): Promise<IncrementalSyncResult> {
    let cursor = initialCursor;
    let aggregate = emptySyncResult();
    for (let page = 0; page < PeerIncrementalSyncProtocol.MAX_SYNC_PAGES; page += 1) {
      const response = await this.sendRequest(connection, {
        version: 1,
        type: 'sync.batch.request',
        cursor,
      });
      if (!isBatchResponse(response) || response.version !== 1) {
        throw createSyncError('Unexpected incremental sync response', `sync:${connection.peerId}`);
      }
      const result = await this.syncService.applyBatch(connection.peerId, response.batch);
      aggregate = mergeSyncResults(aggregate, result);
      if (!result.hasMore || !result.nextCursor || result.nextCursor === cursor) {
        return aggregate;
      }
      cursor = result.nextCursor;
    }
    this.logger.warn('sync_page_limit_reached', { peerId: connection.peerId });
    return aggregate;
  }

  private async syncEntity(
    connection: PeerConnection,
    entity: SyncEntity,
  ): Promise<IncrementalSyncResult> {
    const checkpoints = this.syncService.getCheckpointRepository();
    if (!checkpoints) {
      return emptySyncResult();
    }

    let checkpoint = await checkpoints.get(connection.peerId, entity);
    let cursor = checkpoint?.status === 'scanning' ? checkpoint.cursor : undefined;
    let aggregate = emptySyncResult();

    for (let page = 0; page < PeerIncrementalSyncProtocol.MAX_SYNC_PAGES; page += 1) {
      const manifest = await this.requestEntityManifest(connection, entity, cursor);

      if (cursor && checkpoint?.manifestHash !== manifest.rootHash) {
        this.logger.info('sync_manifest_changed_during_resume', {
          peerId: connection.peerId,
          entity,
        });
        cursor = undefined;
        checkpoint = null;
        continue;
      }

      if (
        !cursor &&
        checkpoint?.status === 'complete' &&
        checkpoint.manifestHash === manifest.rootHash
      ) {
        const localRootHash = await this.syncService.getEntityRootHash(entity);
        if (localRootHash === manifest.rootHash) {
          this.logger.debug('sync_manifest_unchanged', {
            peerId: connection.peerId,
            entity,
            totalItems: manifest.totalItems,
          });
          return emptySyncResult();
        }
      }

      const missingItems = await this.syncService.findMissingManifestItems(manifest);
      let pageResult = emptySyncResult();
      if (missingItems.length > 0) {
        let pendingIds = missingItems.map((item) => item.id);
        while (pendingIds.length > 0) {
          const batch = await this.requestEntityBatch(connection, entity, pendingIds);
          const returnedIds = batch.itemIds ?? [];
          if (returnedIds.length === 0) {
            throw createSyncError(
              'Entity sync batch did not return requested objects',
              `sync:${connection.peerId}:${entity}`,
            );
          }
          const result = await this.syncService.applyBatch(connection.peerId, batch);
          pageResult = mergeSyncResults(pageResult, result);
          aggregate = mergeSyncResults(aggregate, result);
          const returned = new Set(returnedIds);
          pendingIds = pendingIds.filter((id) => !returned.has(id));
        }
      }

      if (manifest.hasMore) {
        if (!manifest.nextCursor || manifest.nextCursor === cursor) {
          throw createSyncError(
            'Entity sync manifest did not advance its cursor',
            `sync:${connection.peerId}:${entity}`,
          );
        }
        checkpoint = await checkpoints.saveProgress({
          peerId: connection.peerId,
          entity,
          cursor: manifest.nextCursor,
          manifestHash: manifest.rootHash,
          syncedObjects: pageResult.applied,
        });
        cursor = manifest.nextCursor;
        continue;
      }

      await checkpoints.markComplete({
        peerId: connection.peerId,
        entity,
        manifestHash: manifest.rootHash,
        syncedObjects: pageResult.applied,
      });
      return { ...aggregate, nextCursor: manifest.nextCursor, hasMore: false };
    }

    this.logger.warn('sync_entity_page_limit_reached', {
      peerId: connection.peerId,
      entity,
    });
    return { ...aggregate, hasMore: true };
  }

  private async requestEntityManifest(
    connection: PeerConnection,
    entity: SyncEntity,
    cursor?: string,
  ): Promise<EntitySyncManifest> {
    const response = await this.sendRequest(connection, {
      version: 2,
      type: 'sync.manifest.request',
      entity,
      cursor,
    });
    if (!isEntityManifestResponse(response) || response.manifest.entity !== entity) {
      throw createSyncError(
        'Unexpected entity manifest response',
        `sync:${connection.peerId}:${entity}`,
      );
    }
    if (!this.syncService.isManifestRangeValid(response.manifest)) {
      throw new AppError({
        code: 'VALIDATION_ERROR',
        message: `Entity manifest range hash is invalid for ${entity}`,
        safeMessage: 'O manifesto recebido do peer falhou na verificacao de integridade.',
        severity: 'warning',
        retryable: true,
        context: {
          scope: 'sync.incremental',
          peerId: connection.peerId,
          entity,
        },
      });
    }
    return response.manifest;
  }

  private async requestEntityBatch(
    connection: PeerConnection,
    entity: SyncEntity,
    itemIds: string[],
  ): Promise<IncrementalSyncBatch> {
    const response = await this.sendRequest(connection, {
      version: 2,
      type: 'sync.batch.request',
      entity,
      itemIds,
    });
    if (!isBatchResponse(response) || response.version !== 2 || response.batch.entity !== entity) {
      throw createSyncError(
        'Unexpected entity batch response',
        `sync:${connection.peerId}:${entity}`,
      );
    }
    return response.batch;
  }

  private async sendRequest(
    connection: PeerConnection,
    payload: SyncRequestPayload,
  ): Promise<SyncResponsePayload> {
    this.requestSequence += 1;
    const correlationId = `sync_${Date.now()}_${connection.peerId}_${this.requestSequence}`;
    const resultPromise = new Promise<SyncResponsePayload>((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        this.pending.delete(correlationId);
        reject(createSyncError('Incremental sync request timed out', correlationId));
      }, PeerIncrementalSyncProtocol.REQUEST_TIMEOUT_MS);
      this.pending.set(correlationId, { resolve, reject, timeout });
    });

    try {
      await connection.send('sync.request', payload, { correlationId });
    } catch (error) {
      const pending = this.pending.get(correlationId);
      this.pending.delete(correlationId);
      if (pending) {
        globalThis.clearTimeout(pending.timeout);
        pending.reject(
          error instanceof Error
            ? error
            : createSyncError('Incremental sync request failed', correlationId),
        );
      }
    }
    return await resultPromise;
  }

  private async handleMessage(message: NetworkMessage, connection: PeerConnection): Promise<void> {
    if (
      message.messageType !== 'sync.request' &&
      message.messageType !== 'sync.response' &&
      message.messageType !== 'sync.hint'
    ) {
      return;
    }
    const peer = this.trustedPeers.get(connection.peerId);
    if (!peer || peer.trustStatus !== 'verified') {
      return;
    }

    const payload = message.payload;
    if (message.messageType === 'sync.hint') {
      if (isSyncRefreshHint(payload)) {
        await this.options.onRefreshRequested?.(connection.peerId);
      }
      return;
    }
    if (message.messageType === 'sync.response') {
      this.resolvePendingResponse(message.correlationId, payload);
      return;
    }
    if (isEntityManifestRequest(payload)) {
      const manifest = await this.syncService.createEntityManifest(
        payload.entity,
        payload.cursor,
        connection.peerId,
      );
      await this.sendResponse(connection, message.correlationId, {
        version: 2,
        type: 'sync.manifest.response',
        manifest,
      });
      return;
    }
    if (isLegacyManifestRequest(payload)) {
      const manifest = await this.syncService.createManifest(payload.cursor, connection.peerId);
      await this.sendResponse(connection, message.correlationId, {
        version: 1,
        type: 'sync.manifest.response',
        manifest,
      });
      return;
    }
    if (isEntityBatchRequest(payload)) {
      const batch = await this.createSizedEntityBatch(
        connection,
        payload.entity,
        payload.itemIds,
        message.correlationId,
      );
      await this.sendResponse(connection, message.correlationId, {
        version: 2,
        type: 'sync.batch.response',
        batch,
      });
      return;
    }
    if (isLegacyBatchRequest(payload)) {
      const batch = await this.createSizedLegacyBatch(
        connection,
        payload.cursor,
        message.correlationId,
      );
      await this.sendResponse(connection, message.correlationId, {
        version: 1,
        type: 'sync.batch.response',
        batch,
      });
    }
  }

  private resolvePendingResponse(correlationId: string | undefined, payload: unknown): void {
    if (!correlationId) {
      return;
    }
    const request = this.pending.get(correlationId);
    if (!request || !isSyncResponse(payload)) {
      return;
    }
    this.pending.delete(correlationId);
    globalThis.clearTimeout(request.timeout);
    request.resolve(payload);
  }

  private async sendResponse(
    connection: PeerConnection,
    correlationId: string | undefined,
    payload: SyncResponsePayload,
  ): Promise<void> {
    try {
      await connection.send('sync.response', payload, { correlationId });
    } catch (error) {
      this.logger.warn('sync_response_send_failed', {
        peerId: connection.peerId,
        correlationId,
        message: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  private async createSizedLegacyBatch(
    connection: PeerConnection,
    cursor?: string,
    correlationId?: string,
  ): Promise<IncrementalSyncBatch> {
    let maxItems = 50;
    while (maxItems >= 1) {
      const batch = await this.syncService.createBatch(cursor, maxItems, connection.peerId);
      if (this.fitsNetworkLimit(connection, batch, correlationId)) {
        return batch;
      }
      this.logger.warn('sync_batch_reduced_for_transport_limit', {
        peerId: connection.peerId,
        maxItems,
      });
      maxItems = Math.floor(maxItems / 2);
    }

    const singleItemBatch = await this.syncService.createBatch(cursor, 1, connection.peerId);
    if (this.fitsNetworkLimit(connection, singleItemBatch, correlationId)) {
      return singleItemBatch;
    }
    this.logger.warn('sync_single_item_exceeds_transport_limit', {
      peerId: connection.peerId,
      cursor,
      nextCursor: singleItemBatch.nextCursor,
    });
    return emptyBatch(singleItemBatch.peerId, 1, {
      cursor: singleItemBatch.cursor,
      nextCursor: singleItemBatch.nextCursor,
      hasMore: singleItemBatch.hasMore,
    });
  }

  private async createSizedEntityBatch(
    connection: PeerConnection,
    entity: SyncEntity,
    itemIds: string[],
    correlationId?: string,
  ): Promise<IncrementalSyncBatch> {
    let requestedIds = itemIds.slice(0, 50);
    while (requestedIds.length > 0) {
      const batch = await this.syncService.createEntityBatch(
        entity,
        requestedIds,
        connection.peerId,
      );
      if (this.fitsNetworkLimit(connection, batch, correlationId)) {
        return batch;
      }
      if (requestedIds.length === 1) {
        throw new AppError({
          code: 'NETWORK_ERROR',
          message: `Sync entity ${entity}/${requestedIds[0]} exceeds the transport limit`,
          safeMessage: 'Um objeto sincronizado excede o limite do transporte P2P.',
          severity: 'warning',
          retryable: false,
          context: {
            scope: 'sync.incremental',
            peerId: connection.peerId,
            entity,
          },
        });
      }
      requestedIds = requestedIds.slice(0, Math.max(1, Math.floor(requestedIds.length / 2)));
    }
    return emptyBatch(connection.localPeerId, 2, { entity });
  }

  private fitsNetworkLimit(
    connection: PeerConnection,
    batch: IncrementalSyncBatch,
    correlationId?: string,
  ): boolean {
    const message = createNetworkMessage({
      messageType: 'sync.response',
      senderId: connection.localPeerId,
      payload: {
        version: batch.version,
        type: 'sync.batch.response',
        batch,
      } satisfies SyncBatchResponse,
      correlationId,
    });
    return JSON.stringify(message).length <= MAX_NETWORK_MESSAGE_BYTES;
  }
}

function createSyncError(message: string, correlationId: string): AppError {
  return new AppError({
    code: 'NETWORK_ERROR',
    message,
    safeMessage: 'A sincronizacao com o peer demorou demais.',
    severity: 'warning',
    retryable: true,
    context: {
      scope: 'sync.incremental',
      correlationId,
    },
  });
}

function emptySyncResult(): IncrementalSyncResult {
  return { applied: 0, skipped: 0, hasMore: false };
}

function isSyncRefreshHint(value: unknown): value is SyncRefreshHint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const hint = value as Record<string, unknown>;
  return (
    hint.version === 1 &&
    hint.type === 'sync.refresh.hint' &&
    typeof hint.changedAt === 'number' &&
    Number.isFinite(hint.changedAt)
  );
}

function mergeSyncResults(
  current: IncrementalSyncResult,
  next: IncrementalSyncResult,
): IncrementalSyncResult {
  return {
    applied: current.applied + next.applied,
    skipped: current.skipped + next.skipped,
    nextCursor: next.nextCursor ?? current.nextCursor,
    hasMore: next.hasMore,
  };
}

function emptyBatch(
  peerId: PeerId,
  version: 1 | 2,
  metadata: {
    entity?: SyncEntity;
    itemIds?: string[];
    cursor?: string;
    nextCursor?: string;
    hasMore?: boolean;
  },
): IncrementalSyncBatch {
  return {
    version,
    peerId,
    entity: metadata.entity,
    itemIds: metadata.itemIds,
    cursor: metadata.cursor,
    nextCursor: metadata.nextCursor,
    hasMore: metadata.hasMore ?? false,
    posts: [],
    profiles: [],
    comments: [],
    reactions: [],
    follows: [],
    chatMessages: [],
  };
}

function isLegacyManifestRequest(value: unknown): value is LegacyManifestRequest {
  const payload = readRecord(value);
  return payload?.version === 1 && payload.type === 'sync.manifest.request';
}

function isLegacyBatchRequest(value: unknown): value is LegacyBatchRequest {
  const payload = readRecord(value);
  return payload?.version === 1 && payload.type === 'sync.batch.request';
}

function isEntityManifestRequest(value: unknown): value is EntityManifestRequest {
  const payload = readRecord(value);
  return (
    payload?.version === 2 &&
    payload.type === 'sync.manifest.request' &&
    isSyncEntity(payload.entity) &&
    (payload.cursor === undefined || typeof payload.cursor === 'string')
  );
}

function isEntityBatchRequest(value: unknown): value is EntityBatchRequest {
  const payload = readRecord(value);
  return (
    payload?.version === 2 &&
    payload.type === 'sync.batch.request' &&
    isSyncEntity(payload.entity) &&
    Array.isArray(payload.itemIds) &&
    payload.itemIds.length <= 50 &&
    payload.itemIds.every((item) => typeof item === 'string' && item.length > 0)
  );
}

function isSyncResponse(value: unknown): value is SyncResponsePayload {
  return (
    isLegacyManifestResponse(value) || isEntityManifestResponse(value) || isBatchResponse(value)
  );
}

function isLegacyManifestResponse(value: unknown): value is LegacyManifestResponse {
  const payload = readRecord(value);
  return (
    payload?.version === 1 &&
    payload.type === 'sync.manifest.response' &&
    isLegacyManifest(payload.manifest)
  );
}

function isEntityManifestResponse(value: unknown): value is EntityManifestResponse {
  const payload = readRecord(value);
  return (
    payload?.version === 2 &&
    payload.type === 'sync.manifest.response' &&
    isEntityManifest(payload.manifest)
  );
}

function isBatchResponse(value: unknown): value is SyncBatchResponse {
  const payload = readRecord(value);
  return (
    (payload?.version === 1 || payload?.version === 2) &&
    payload.type === 'sync.batch.response' &&
    isBatch(payload.batch) &&
    payload.batch.version === payload.version
  );
}

function isLegacyManifest(value: unknown): value is IncrementalSyncManifest {
  const manifest = readRecord(value);
  return (
    manifest?.version === 1 && typeof manifest.peerId === 'string' && Array.isArray(manifest.items)
  );
}

function isEntityManifest(value: unknown): value is EntitySyncManifest {
  const manifest = readRecord(value);
  const entity = manifest?.entity;
  return (
    manifest?.version === 2 &&
    typeof manifest.peerId === 'string' &&
    isSyncEntity(entity) &&
    typeof manifest.rootHash === 'string' &&
    typeof manifest.rangeHash === 'string' &&
    typeof manifest.totalItems === 'number' &&
    Number.isFinite(manifest.totalItems) &&
    typeof manifest.hasMore === 'boolean' &&
    (manifest.cursor === undefined || typeof manifest.cursor === 'string') &&
    (manifest.nextCursor === undefined || typeof manifest.nextCursor === 'string') &&
    Array.isArray(manifest.items) &&
    manifest.items.every((item) => isManifestItem(item, entity))
  );
}

function isManifestItem(value: unknown, entity: SyncEntity): boolean {
  const item = readRecord(value);
  return (
    item?.entity === entity &&
    typeof item.id === 'string' &&
    typeof item.contentHash === 'string' &&
    typeof item.stateHash === 'string' &&
    typeof item.updatedAt === 'number' &&
    Number.isFinite(item.updatedAt) &&
    typeof item.author === 'string' &&
    typeof item.deleted === 'boolean'
  );
}

function isBatch(value: unknown): value is IncrementalSyncBatch {
  const batch = readRecord(value);
  return (
    (batch?.version === 1 || batch?.version === 2) &&
    typeof batch.peerId === 'string' &&
    (batch.version === 1 || isSyncEntity(batch.entity)) &&
    (batch.itemIds === undefined ||
      (Array.isArray(batch.itemIds) &&
        batch.itemIds.every((item) => typeof item === 'string' && item.length > 0))) &&
    typeof batch.hasMore === 'boolean' &&
    Array.isArray(batch.posts) &&
    (batch.profiles === undefined || Array.isArray(batch.profiles)) &&
    (batch.comments === undefined || Array.isArray(batch.comments)) &&
    (batch.reactions === undefined || Array.isArray(batch.reactions)) &&
    (batch.follows === undefined || Array.isArray(batch.follows)) &&
    (batch.chatMessages === undefined || Array.isArray(batch.chatMessages))
  );
}

function isSyncEntity(value: unknown): value is SyncEntity {
  return typeof value === 'string' && SYNC_ENTITIES.includes(value as SyncEntity);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
