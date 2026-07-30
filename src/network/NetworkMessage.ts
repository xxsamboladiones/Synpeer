import { sha256Hex } from '@/utils/hash';

export const NETWORK_PROTOCOL_VERSION = 1;
export const MAX_NETWORK_MESSAGE_BYTES = 256 * 1024;

export type NetworkMessageType =
  | 'peer.invite'
  | 'peer.handshake'
  | 'peer.heartbeat'
  | 'social.post'
  | 'social.profile'
  | 'social.comment'
  | 'social.reaction'
  | 'social.follow'
  | 'social.chat'
  | 'social.chat.receipt'
  | 'social.ack'
  | 'sync.manifest'
  | 'sync.request'
  | 'sync.response'
  | 'sync.hint'
  | 'consensus.proposal'
  | 'consensus.vote'
  | 'consensus.result'
  | 'media.chunk.request'
  | 'media.chunk.response'
  | 'media.chunk.part'
  | 'media.availability.announce'
  | 'unknown';

export interface NetworkMessage<TPayload = unknown> {
  protocolVersion: 1;
  messageId: string;
  messageType: NetworkMessageType;
  senderId: string;
  timestamp: number;
  payload: TPayload;
  signature?: string;
  correlationId?: string;
  sequence?: number;
  ttlMs: number;
}

export type NetworkMessageValidationResult =
  { valid: true; message: NetworkMessage } | { valid: false; error: string };

export function createNetworkMessage<TPayload>(input: {
  messageType: NetworkMessageType;
  senderId: string;
  payload: TPayload;
  signature?: string;
  correlationId?: string;
  sequence?: number;
  ttlMs?: number;
  timestamp?: number;
}): NetworkMessage<TPayload> {
  const timestamp = input.timestamp ?? Date.now();
  const ttlMs = input.ttlMs ?? 60000;
  const canonicalPayload = JSON.stringify({
    protocolVersion: NETWORK_PROTOCOL_VERSION,
    messageType: input.messageType,
    senderId: input.senderId,
    timestamp,
    payload: input.payload,
    correlationId: input.correlationId ?? null,
    sequence: input.sequence ?? null,
    ttlMs,
  });

  return {
    protocolVersion: NETWORK_PROTOCOL_VERSION,
    messageId: sha256Hex(canonicalPayload),
    messageType: input.messageType,
    senderId: input.senderId,
    timestamp,
    payload: input.payload,
    signature: input.signature,
    correlationId: input.correlationId,
    sequence: input.sequence,
    ttlMs,
  };
}

export function validateNetworkMessage(
  data: unknown,
  now = Date.now(),
): NetworkMessageValidationResult {
  if (!isRecord(data)) {
    return { valid: false, error: 'Message must be an object' };
  }

  if (data.protocolVersion !== NETWORK_PROTOCOL_VERSION) {
    return { valid: false, error: 'Unsupported protocol version' };
  }

  if (typeof data.messageId !== 'string' || data.messageId.length === 0) {
    return { valid: false, error: 'Missing message id' };
  }

  if (typeof data.messageType !== 'string') {
    return { valid: false, error: 'Missing message type' };
  }

  if (typeof data.senderId !== 'string' || data.senderId.length === 0) {
    return { valid: false, error: 'Missing sender id' };
  }

  if (typeof data.timestamp !== 'number' || !Number.isFinite(data.timestamp)) {
    return { valid: false, error: 'Invalid timestamp' };
  }

  if (typeof data.ttlMs !== 'number' || data.ttlMs <= 0) {
    return { valid: false, error: 'Invalid TTL' };
  }

  if (data.timestamp + data.ttlMs < now) {
    return { valid: false, error: 'Message expired' };
  }

  if (estimateMessageBytes(data) > MAX_NETWORK_MESSAGE_BYTES) {
    return { valid: false, error: 'Message exceeds size limit' };
  }

  return {
    valid: true,
    message: {
      protocolVersion: NETWORK_PROTOCOL_VERSION,
      messageId: data.messageId,
      messageType: data.messageType as NetworkMessageType,
      senderId: data.senderId,
      timestamp: data.timestamp,
      payload: data.payload,
      signature: typeof data.signature === 'string' ? data.signature : undefined,
      correlationId: typeof data.correlationId === 'string' ? data.correlationId : undefined,
      sequence: typeof data.sequence === 'number' ? data.sequence : undefined,
      ttlMs: data.ttlMs,
    },
  };
}

export class NetworkMessageDeduplicator {
  private seen = new Map<string, number>();

  constructor(private readonly maxEntries = 1000) {}

  accept(message: NetworkMessage, now = Date.now()): boolean {
    this.prune(now);
    if (this.seen.has(message.messageId)) {
      return false;
    }

    this.seen.set(message.messageId, message.timestamp + message.ttlMs);
    if (this.seen.size > this.maxEntries) {
      const oldest = [...this.seen.entries()].sort((left, right) => left[1] - right[1])[0];
      if (oldest) {
        this.seen.delete(oldest[0]);
      }
    }
    return true;
  }

  clear(): void {
    this.seen.clear();
  }

  private prune(now: number): void {
    for (const [messageId, expiresAt] of this.seen.entries()) {
      if (expiresAt < now) {
        this.seen.delete(messageId);
      }
    }
  }
}

function estimateMessageBytes(data: unknown): number {
  try {
    return JSON.stringify(data).length;
  } catch {
    return MAX_NETWORK_MESSAGE_BYTES + 1;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
