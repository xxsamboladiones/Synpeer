import { AppError } from '@/errors/AppError';
import type { CommentData } from '@/models/Comment';
import type { FollowData } from '@/models/Follow';
import type { ChatMessageData } from '@/models/ChatMessage';
import type { PostData } from '@/models/Post';
import type { ProfileData } from '@/models/Profile';
import type { ReactionData } from '@/models/Reaction';
import {
  createNetworkMessage,
  MAX_NETWORK_MESSAGE_BYTES,
  type NetworkMessage,
} from '@/network/NetworkMessage';
import type { PeerId } from '@/network/NetworkTypes';
import type { PeerTransport } from '@/network/PeerTransport';
import { createLogger } from '@/observability/Logger';

import {
  createQueueItemId,
  SOCIAL_OUTBOX_DELIVERY_TTL_MS,
  SocialReplicationQueueRepository,
  type SocialInboxClaim,
  type SocialReplicationQueueItem,
  type SocialReplicationQueueSummary,
} from './SocialReplicationQueueRepository';
import {
  isChatReceipt,
  isPrivateChatEnvelope,
  type ChatDeliveryReceiptV1,
  type ChatReadReceiptV1,
  type ChatReceiptV1,
  type PrivateChatEnvelopeV1,
} from './PrivateChatProtocol';

const SOCIAL_REPLICATION_RETRY_BASE_MS = 5000;

export type SocialWirePayload =
  | ({ version: 1; entity: 'post'; action: 'upsert'; post: PostData } & SocialGossipPayload)
  | ({
      version: 1;
      entity: 'profile';
      action: 'upsert';
      profile: ProfileData;
    } & SocialGossipPayload)
  | ({
      version: 1;
      entity: 'comment';
      action: 'upsert';
      comment: CommentData;
    } & SocialGossipPayload)
  | ({
      version: 1;
      entity: 'reaction';
      action: 'upsert';
      reaction: ReactionData;
    } & SocialGossipPayload)
  | ({ version: 1; entity: 'follow'; action: 'upsert'; follow: FollowData } & SocialGossipPayload)
  | ({
      version: 1;
      entity: 'chat';
      action: 'upsert';
      envelope: PrivateChatEnvelopeV1;
    } & SocialGossipPayload)
  | ({
      version: 1;
      entity: 'chat-receipt';
      action: 'upsert';
      receipt: ChatReceiptV1;
    } & SocialGossipPayload)
  | ({
      version: 1;
      entity: 'chat';
      action: 'upsert';
      chat: ChatMessageData;
      legacy: true;
    } & SocialGossipPayload);

export interface SocialGossipMetadata {
  version: 1;
  originPeerId: PeerId;
  objectId: string;
  ttl: number;
  path: PeerId[];
  expiresAt?: number;
}

interface SocialGossipPayload {
  gossip?: SocialGossipMetadata;
}

export interface ReplicationResult {
  attemptedPeers: number;
  successfulPeers: string[];
  failedPeers: Array<{ peerId: string; errorCode: string }>;
}

export interface SocialAckPayload {
  version: 1;
  type: 'social.ack';
  queueItemId: string;
  objectId: string;
  entity: SocialWirePayload['entity'];
  applied: boolean;
  skipped: boolean;
  conflict: boolean;
  errorCode?: string;
}

export class SocialReplicationService {
  static readonly DEFAULT_GOSSIP_TTL = 8;
  private static readonly SEND_TIMEOUT_MS = 5000;
  private static readonly ACK_TIMEOUT_MS = 5000;
  private static readonly ACK_RETENTION_MS = 24 * 60 * 60 * 1000;
  private readonly logger = createLogger('social.replication');
  private readonly pendingAcks = new Map<string, (payload: SocialAckPayload | null) => void>();
  private retryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private retryScheduling: Promise<void> | null = null;
  private processingQueue = false;
  private stopped = false;
  private queueStatus: SocialReplicationQueueSummary = emptyQueueSummary();

  constructor(
    private readonly localPeerId: PeerId,
    private readonly getPeerTransport: () => PeerTransport | null,
    private readonly getAuthenticatedPeers: () => PeerId[],
    private readonly queueRepository?: SocialReplicationQueueRepository,
  ) {}

  async replicatePost(post: PostData): Promise<ReplicationResult> {
    return await this.replicate({
      version: 1,
      entity: 'post',
      action: 'upsert',
      post,
    });
  }

  async replicateProfile(profile: ProfileData): Promise<ReplicationResult> {
    return await this.replicate({
      version: 1,
      entity: 'profile',
      action: 'upsert',
      profile,
    });
  }

  async replicateComment(comment: CommentData): Promise<ReplicationResult> {
    return await this.replicate({
      version: 1,
      entity: 'comment',
      action: 'upsert',
      comment,
    });
  }

  async replicateReaction(reaction: ReactionData): Promise<ReplicationResult> {
    return await this.replicate({
      version: 1,
      entity: 'reaction',
      action: 'upsert',
      reaction,
    });
  }

  async replicateFollow(follow: FollowData): Promise<ReplicationResult> {
    return await this.replicate({
      version: 1,
      entity: 'follow',
      action: 'upsert',
      follow,
    });
  }

  async replicatePrivateChatEnvelope(envelope: PrivateChatEnvelopeV1): Promise<ReplicationResult> {
    return await this.replicate({
      version: 1,
      entity: 'chat',
      action: 'upsert',
      envelope,
    });
  }

  async replicateChatDeliveryReceipt(receipt: ChatDeliveryReceiptV1): Promise<ReplicationResult> {
    await this.recordChatDeliveryReceipt(receipt);
    return await this.replicateChatReceipt(receipt);
  }

  async acquireChatDeliveryReceiptCustody(receipt: ChatDeliveryReceiptV1): Promise<boolean> {
    await this.recordChatDeliveryReceipt(receipt);
    if (!this.queueRepository) {
      return false;
    }
    await this.queueRepository.upsertPayload(
      ensureGossipPayload(
        {
          version: 1,
          entity: 'chat-receipt',
          action: 'upsert',
          receipt,
        },
        this.localPeerId,
      ),
    );
    await this.refreshQueueStatus();
    this.scheduleNextQueueRetry();
    return true;
  }

  async replicateChatReadReceipt(receipt: ChatReadReceiptV1): Promise<ReplicationResult> {
    await this.recordChatReadReceipt(receipt);
    return await this.replicateChatReceipt(receipt);
  }

  private async replicateChatReceipt(receipt: ChatReceiptV1): Promise<ReplicationResult> {
    return await this.replicate({
      version: 1,
      entity: 'chat-receipt',
      action: 'upsert',
      receipt,
    });
  }

  async handleAck(message: NetworkMessage, peerId: PeerId): Promise<boolean> {
    if (message.messageType !== 'social.ack' || !isSocialAckPayload(message.payload)) {
      return false;
    }
    const ack = message.payload;
    await this.queueRepository?.markPeerAcked(ack.queueItemId, peerId);
    await this.refreshQueueStatus();
    this.resolvePendingAck(ack.queueItemId, peerId, ack);
    return true;
  }

  async recordChatDeliveryReceipt(receipt: ChatDeliveryReceiptV1): Promise<boolean> {
    const recorded = (await this.queueRepository?.recordChatDeliveryReceipt(receipt)) ?? true;
    await this.refreshQueueStatus();
    return recorded;
  }

  async recordChatReadReceipt(receipt: ChatReadReceiptV1): Promise<boolean> {
    const recorded = (await this.queueRepository?.recordChatReceipt(receipt)) ?? true;
    await this.refreshQueueStatus();
    return recorded;
  }

  async claimIncoming(
    message: NetworkMessage,
    payload: SocialWirePayload,
    sourcePeerId: PeerId,
  ): Promise<SocialInboxClaim | null> {
    if (!this.queueRepository) {
      return null;
    }
    return await this.queueRepository.claimIncoming({
      deliveryId: message.correlationId ?? message.messageId,
      networkMessageId: message.messageId,
      payload,
      sourcePeerId,
    });
  }

  async markIncomingApplied(deliveryId: string): Promise<boolean> {
    return (await this.queueRepository?.markIncomingApplied(deliveryId)) ?? true;
  }

  async markIncomingRejected(deliveryId: string, errorCode: string): Promise<boolean> {
    return (await this.queueRepository?.markIncomingRejected(deliveryId, errorCode)) ?? true;
  }

  async listChatReceipts(): Promise<ChatReceiptV1[]> {
    return (await this.queueRepository?.listChatReceipts()) ?? [];
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (!this.queueRepository) {
      return;
    }
    const recovered = await this.queueRepository.recoverInterrupted(Date.now(), true);
    const garbageCollected = await this.queueRepository.garbageCollect();
    if (recovered > 0 || garbageCollected > 0) {
      this.logger.info('delivery_state_recovered', { recovered, garbageCollected });
    }
    await this.refreshQueueStatus();
    await this.processPendingQueue();
  }

  getQueueStatus(): Readonly<SocialReplicationQueueSummary> {
    return { ...this.queueStatus };
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      globalThis.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    for (const resolver of this.pendingAcks.values()) {
      resolver(null);
    }
    this.pendingAcks.clear();
  }

  async processPendingQueue(): Promise<ReplicationResult> {
    if (!this.queueRepository || this.processingQueue) {
      return emptyReplicationResult();
    }
    this.processingQueue = true;
    const aggregate = emptyReplicationResult();
    try {
      await this.queueRepository.clearAcked(SocialReplicationService.ACK_RETENTION_MS);
      for (const item of await this.queueRepository.listPending()) {
        const result = await this.sendQueuedItem(item);
        aggregate.attemptedPeers += result.attemptedPeers;
        aggregate.successfulPeers.push(...result.successfulPeers);
        aggregate.failedPeers.push(...result.failedPeers);
      }
      return aggregate;
    } finally {
      this.processingQueue = false;
      await this.refreshQueueStatus();
      this.scheduleNextQueueRetry();
    }
  }

  async gossipRemotePayload(
    payload: SocialWirePayload,
    receivedFromPeerId: PeerId,
  ): Promise<ReplicationResult> {
    const forwardedPayload = createForwardedPayload(payload, receivedFromPeerId, this.localPeerId);
    if (!forwardedPayload) {
      return emptyReplicationResult();
    }

    return await this.replicate(
      forwardedPayload,
      getGossipExcludedPeers(forwardedPayload, receivedFromPeerId),
    );
  }

  async acquireRelayCustody(
    payload: SocialWirePayload,
    receivedFromPeerId: PeerId,
  ): Promise<boolean> {
    const forwardedPayload = createForwardedPayload(payload, receivedFromPeerId, this.localPeerId);
    if (!forwardedPayload || !this.queueRepository) {
      return false;
    }
    await this.queueRepository.upsertPayload(forwardedPayload);
    await this.refreshQueueStatus();
    this.scheduleNextQueueRetry();
    return true;
  }

  private async replicate(
    payload: SocialWirePayload,
    excludedPeers: ReadonlySet<PeerId> = new Set(),
  ): Promise<ReplicationResult> {
    const preparedPayload = ensureGossipPayload(payload, this.localPeerId);
    const queueItem = await this.queueRepository?.upsertPayload(preparedPayload);
    if (queueItem) {
      try {
        return await this.sendQueuedItem(queueItem, excludedPeers);
      } finally {
        await this.refreshQueueStatus();
        this.scheduleNextQueueRetry();
      }
    }
    return await this.sendPayload(
      preparedPayload,
      excludedPeers,
      createQueueItemId(preparedPayload),
    );
  }

  private async sendQueuedItem(
    item: SocialReplicationQueueItem,
    excludedPeers: ReadonlySet<PeerId> = new Set(),
  ): Promise<ReplicationResult> {
    const effectiveExcludedPeers = mergeExcludedPeers(
      excludedPeers,
      getGossipExcludedPeers(item.payload),
    );
    if (!this.hasPendingDeliveryTarget(item, effectiveExcludedPeers)) {
      if (this.getAuthenticatedPeers().length > 0) {
        await this.queueRepository?.markPending(
          item.id,
          getRetryDelayMs(Math.max(1, item.attempts)),
        );
      }
      return emptyReplicationResult();
    }
    const claimed = await this.queueRepository?.markSending(item.id);
    if (this.queueRepository && (!claimed || claimed.status !== 'sending')) {
      return emptyReplicationResult();
    }
    const activeItem = claimed ?? item;
    const result = await this.sendPayload(
      activeItem.payload,
      effectiveExcludedPeers,
      activeItem.id,
      activeItem.relayPeerIds,
    );
    const current = await this.queueRepository?.get(activeItem.id);
    if (current?.status === 'delivered' || current?.status === 'read') {
      return result;
    }
    if (result.attemptedPeers === 0 && result.successfulPeers.length === 0) {
      if (isPrivateChatPayload(item.payload)) {
        await this.queueRepository?.markPending(
          activeItem.id,
          getRetryDelayMs(activeItem.attempts + 1),
        );
      } else {
        await this.queueRepository?.markFailed(
          activeItem.id,
          [],
          getRetryDelayMs(activeItem.attempts + 1),
        );
      }
      return result;
    }
    if (isPrivateChatPayload(item.payload) && result.successfulPeers.length > 0) {
      await this.queueRepository?.markPending(
        activeItem.id,
        getRetryDelayMs(activeItem.attempts + 1),
      );
      return result;
    }
    if (result.failedPeers.length === 0 && result.successfulPeers.length > 0) {
      await this.queueRepository?.markDelivered(activeItem.id);
      return result;
    }
    if (result.failedPeers.length > 0) {
      if (
        result.failedPeers.length === result.attemptedPeers &&
        result.failedPeers.every((peer) => peer.errorCode === 'NETWORK_MESSAGE_TOO_LARGE')
      ) {
        await this.queueRepository?.markDeadLetter(activeItem.id, 'NETWORK_MESSAGE_TOO_LARGE');
        return result;
      }
      await this.queueRepository?.markFailed(
        activeItem.id,
        result.failedPeers.map((peer) => ({
          peerId: peer.peerId as PeerId,
          errorCode: peer.errorCode,
        })),
        getRetryDelayMs(activeItem.attempts + 1),
      );
    }
    return result;
  }

  private hasPendingDeliveryTarget(
    item: SocialReplicationQueueItem,
    excludedPeers: ReadonlySet<PeerId>,
  ): boolean {
    if (!this.getPeerTransport()) {
      return false;
    }
    const transport = this.getPeerTransport();
    return this.getAuthenticatedPeers().some(
      (peerId) =>
        !excludedPeers.has(peerId) &&
        !item.relayPeerIds.includes(peerId) &&
        Boolean(transport?.getConnection(peerId)),
    );
  }

  private async sendPayload(
    preparedPayload: SocialWirePayload,
    excludedPeers: ReadonlySet<PeerId>,
    queueItemId: string,
    alreadyAckedPeers: readonly PeerId[] = [],
  ): Promise<ReplicationResult> {
    const transport = this.getPeerTransport();
    const peers = this.getAuthenticatedPeers().filter(
      (peerId) => !excludedPeers.has(peerId) && Boolean(transport?.getConnection(peerId)),
    );
    const pendingPeers = peers.filter((peerId) => !alreadyAckedPeers.includes(peerId));
    const result: ReplicationResult = {
      attemptedPeers: pendingPeers.length,
      successfulPeers: [...alreadyAckedPeers],
      failedPeers: [],
    };

    if (!transport || pendingPeers.length === 0) {
      return result;
    }

    const message = createNetworkMessage({
      messageType: getSocialMessageType(preparedPayload),
      senderId: this.localPeerId,
      payload: preparedPayload,
      ttlMs: 5 * 60 * 1000,
      correlationId: queueItemId,
    });
    const messageBytes = estimateMessageBytes(message);

    for (const peerId of pendingPeers) {
      if (messageBytes > MAX_NETWORK_MESSAGE_BYTES) {
        result.failedPeers.push({ peerId, errorCode: 'NETWORK_MESSAGE_TOO_LARGE' });
        this.logger.warn('peer_replication_payload_too_large', {
          peerId,
          entity: preparedPayload.entity,
          messageBytes,
          maxBytes: MAX_NETWORK_MESSAGE_BYTES,
        });
        continue;
      }
      try {
        const ackPromise = this.waitForAck(queueItemId, peerId);
        await withTimeout(
          transport.send(peerId, message as NetworkMessage<SocialWirePayload>),
          SocialReplicationService.SEND_TIMEOUT_MS,
        );
        const ack = await ackPromise;
        if (!ack?.applied && !ack?.skipped) {
          result.failedPeers.push({
            peerId,
            errorCode: ack?.errorCode ?? 'SOCIAL_REPLICATION_NOT_APPLIED',
          });
          continue;
        }
        result.successfulPeers.push(peerId);
      } catch (error) {
        this.resolvePendingAck(queueItemId, peerId, null);
        const errorCode = error instanceof AppError ? error.code : 'SOCIAL_REPLICATION_FAILED';
        result.failedPeers.push({ peerId, errorCode });
        this.logger.warn('peer_replication_failed', {
          peerId,
          errorCode,
          entity: preparedPayload.entity,
        });
      }
    }

    return result;
  }

  private async waitForAck(queueItemId: string, peerId: PeerId): Promise<SocialAckPayload | null> {
    return await new Promise((resolve) => {
      const key = createAckKey(queueItemId, peerId);
      const timeout = globalThis.setTimeout(() => {
        this.pendingAcks.delete(key);
        resolve(null);
      }, SocialReplicationService.ACK_TIMEOUT_MS);
      this.pendingAcks.set(key, (payload) => {
        globalThis.clearTimeout(timeout);
        this.pendingAcks.delete(key);
        resolve(payload);
      });
    });
  }

  private resolvePendingAck(
    queueItemId: string,
    peerId: PeerId,
    payload: SocialAckPayload | null,
  ): void {
    const resolver = this.pendingAcks.get(createAckKey(queueItemId, peerId));
    resolver?.(payload);
  }

  private scheduleNextQueueRetry(): void {
    if (
      !this.queueRepository ||
      this.stopped ||
      this.retryTimer ||
      this.retryScheduling ||
      this.getAuthenticatedPeers().length === 0
    ) {
      return;
    }
    this.retryScheduling = this.queueRepository
      .getNextAttemptAt()
      .then((nextAttemptAt) => {
        if (this.stopped || nextAttemptAt === null || this.retryTimer) {
          return;
        }
        const delayMs = Math.max(250, nextAttemptAt - Date.now());
        this.retryTimer = globalThis.setTimeout(() => {
          this.retryTimer = null;
          void this.processPendingQueue().catch((error) => {
            const errorCode = error instanceof AppError ? error.code : 'SOCIAL_REPLICATION_FAILED';
            this.logger.warn('replication_queue_retry_failed', { errorCode });
          });
        }, delayMs);
      })
      .finally(() => {
        this.retryScheduling = null;
      });
  }

  private async refreshQueueStatus(): Promise<void> {
    if (!this.queueRepository) {
      this.queueStatus = emptyQueueSummary();
      return;
    }
    this.queueStatus = await this.queueRepository.getStatus();
  }
}

function emptyReplicationResult(): ReplicationResult {
  return {
    attemptedPeers: 0,
    successfulPeers: [],
    failedPeers: [],
  };
}

function ensureGossipPayload(payload: SocialWirePayload, localPeerId: PeerId): SocialWirePayload {
  if (payload.gossip) {
    return payload;
  }
  return withGossip(payload, {
    version: 1,
    originPeerId: localPeerId,
    objectId: getPayloadObjectId(payload),
    ttl: SocialReplicationService.DEFAULT_GOSSIP_TTL,
    path: [localPeerId],
    expiresAt: Date.now() + SOCIAL_OUTBOX_DELIVERY_TTL_MS,
  });
}

function withGossip(payload: SocialWirePayload, gossip: SocialGossipMetadata): SocialWirePayload {
  return {
    ...payload,
    gossip,
  };
}

function appendUniquePeer(path: PeerId[], peerId: PeerId): PeerId[] {
  return path.includes(peerId) ? path : [...path, peerId];
}

function createForwardedPayload(
  payload: SocialWirePayload,
  receivedFromPeerId: PeerId,
  localPeerId: PeerId,
): SocialWirePayload | null {
  const gossip = payload.gossip;
  if (
    !gossip ||
    gossip.ttl <= 1 ||
    gossip.path.includes(localPeerId) ||
    gossip.path.includes(receivedFromPeerId) === false ||
    (payload.entity === 'chat-receipt' && payload.receipt.senderId === localPeerId)
  ) {
    return null;
  }
  return withGossip(payload, {
    ...gossip,
    ttl: gossip.ttl - 1,
    path: appendUniquePeer(gossip.path, localPeerId),
  });
}

function getGossipExcludedPeers(
  payload: SocialWirePayload,
  receivedFromPeerId?: PeerId,
): ReadonlySet<PeerId> {
  const gossip = payload.gossip;
  return new Set(
    gossip
      ? [...(receivedFromPeerId ? [receivedFromPeerId] : []), gossip.originPeerId, ...gossip.path]
      : receivedFromPeerId
        ? [receivedFromPeerId]
        : [],
  );
}

function mergeExcludedPeers(
  left: ReadonlySet<PeerId>,
  right: ReadonlySet<PeerId>,
): ReadonlySet<PeerId> {
  return new Set([...left, ...right]);
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

export function createSocialAckPayload(input: {
  queueItemId: string;
  payload: SocialWirePayload;
  applied: boolean;
  skipped: boolean;
  conflict: boolean;
  errorCode?: string;
}): SocialAckPayload {
  return {
    version: 1,
    type: 'social.ack',
    queueItemId: input.queueItemId,
    objectId: getPayloadObjectId(input.payload),
    entity: input.payload.entity,
    applied: input.applied,
    skipped: input.skipped,
    conflict: input.conflict,
    errorCode: input.errorCode,
  };
}

export function isSocialWirePayload(value: unknown): value is SocialWirePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  if (payload.version !== 1 || payload.action !== 'upsert') {
    return false;
  }
  if (payload.gossip !== undefined && !isSocialGossipMetadata(payload.gossip)) {
    return false;
  }
  if (payload.entity === 'post') {
    return typeof payload.post === 'object' && payload.post !== null;
  }
  if (payload.entity === 'profile') {
    return typeof payload.profile === 'object' && payload.profile !== null;
  }
  if (payload.entity === 'comment') {
    return typeof payload.comment === 'object' && payload.comment !== null;
  }
  if (payload.entity === 'reaction') {
    return typeof payload.reaction === 'object' && payload.reaction !== null;
  }
  if (payload.entity === 'follow') {
    return typeof payload.follow === 'object' && payload.follow !== null;
  }
  if (payload.entity === 'chat') {
    if (isPrivateChatPayloadRecord(payload)) {
      return true;
    }
    return payload.legacy === true && typeof payload.chat === 'object' && payload.chat !== null;
  }
  if (payload.entity === 'chat-receipt') {
    return isChatReceipt(payload.receipt);
  }
  return false;
}

function isPrivateChatPayload(
  payload: SocialWirePayload,
): payload is Extract<SocialWirePayload, { entity: 'chat'; envelope: PrivateChatEnvelopeV1 }> {
  return payload.entity === 'chat' && 'envelope' in payload;
}

function isPrivateChatPayloadRecord(
  payload: Record<string, unknown>,
): payload is Record<string, unknown> & { envelope: PrivateChatEnvelopeV1 } {
  return isPrivateChatEnvelope(payload.envelope);
}

function getSocialMessageType(payload: SocialWirePayload): NetworkMessage['messageType'] {
  return payload.entity === 'chat-receipt' ? 'social.chat.receipt' : `social.${payload.entity}`;
}

function isSocialGossipMetadata(value: unknown): value is SocialGossipMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const gossip = value as Record<string, unknown>;
  return (
    gossip.version === 1 &&
    typeof gossip.originPeerId === 'string' &&
    gossip.originPeerId.length > 0 &&
    typeof gossip.objectId === 'string' &&
    gossip.objectId.length > 0 &&
    typeof gossip.ttl === 'number' &&
    Number.isInteger(gossip.ttl) &&
    gossip.ttl > 0 &&
    gossip.ttl <= SocialReplicationService.DEFAULT_GOSSIP_TTL &&
    Array.isArray(gossip.path) &&
    gossip.path.every((peerId) => typeof peerId === 'string' && peerId.length > 0) &&
    (gossip.expiresAt === undefined ||
      (typeof gossip.expiresAt === 'number' &&
        Number.isFinite(gossip.expiresAt) &&
        gossip.expiresAt > 0))
  );
}

function emptyQueueSummary(): SocialReplicationQueueSummary {
  return {
    pending: 0,
    sending: 0,
    acked: 0,
    failed: 0,
    queued: 0,
    relayed: 0,
    delivered: 0,
    read: 0,
    expired: 0,
    deadLetter: 0,
  };
}

function estimateMessageBytes(message: NetworkMessage): number {
  try {
    return JSON.stringify(message).length;
  } catch {
    return MAX_NETWORK_MESSAGE_BYTES + 1;
  }
}

function createAckKey(queueItemId: string, peerId: PeerId): string {
  return `${queueItemId}:${peerId}`;
}

function getRetryDelayMs(attempts: number): number {
  return Math.min(
    5 * 60 * 1000,
    SOCIAL_REPLICATION_RETRY_BASE_MS * Math.max(1, 2 ** Math.max(0, attempts - 1)),
  );
}

function isSocialAckPayload(value: unknown): value is SocialAckPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  return (
    payload.version === 1 &&
    payload.type === 'social.ack' &&
    typeof payload.queueItemId === 'string' &&
    typeof payload.objectId === 'string' &&
    typeof payload.entity === 'string' &&
    typeof payload.applied === 'boolean' &&
    typeof payload.skipped === 'boolean' &&
    typeof payload.conflict === 'boolean' &&
    (payload.errorCode === undefined || typeof payload.errorCode === 'string')
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = globalThis.setTimeout(() => {
          reject(
            new AppError({
              code: 'NETWORK_ERROR',
              message: 'Social replication send timed out',
              safeMessage: 'A sincronizacao com o peer demorou demais.',
              severity: 'warning',
              retryable: true,
            }),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      globalThis.clearTimeout(timeout);
    }
  }
}
