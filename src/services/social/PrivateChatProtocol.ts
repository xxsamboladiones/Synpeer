import type { PrivateMessageCiphertext } from '@/crypto/CryptoTypes';
import type { ChatMessageData } from '@/models/ChatMessage';
import type { PeerId } from '@/network/NetworkTypes';
import { sha256Hex } from '@/utils/hash';

export interface PrivateChatEnvelopeV1 extends PrivateMessageCiphertext {
  type: 'chat.private.envelope';
  messageId: string;
  senderId: PeerId;
  recipientId: PeerId;
  createdAt: number;
  ciphertextHash: string;
  signature: string;
}

export interface ChatDeliveryReceiptV1 {
  version: 1;
  type: 'chat.delivery.receipt';
  messageId: string;
  senderId: PeerId;
  recipientId: PeerId;
  deliveredAt: number;
  signature: string;
}

export interface ChatReadReceiptV1 {
  version: 1;
  type: 'chat.read.receipt';
  messageId: string;
  senderId: PeerId;
  recipientId: PeerId;
  readAt: number;
  signature: string;
}

export type ChatReceiptV1 = ChatDeliveryReceiptV1 | ChatReadReceiptV1;

export function createPrivateChatContext(input: {
  messageId: string;
  senderId: PeerId;
  recipientId: PeerId;
}): string {
  return `synpeer:chat:v1:${input.messageId}:${input.senderId}:${input.recipientId}`;
}

export function createUnsignedPrivateChatEnvelope(input: {
  message: ChatMessageData;
  encrypted: PrivateMessageCiphertext;
}): Omit<PrivateChatEnvelopeV1, 'signature'> {
  return {
    ...input.encrypted,
    type: 'chat.private.envelope',
    messageId: input.message.id,
    senderId: input.message.senderId,
    recipientId: input.message.recipientId,
    createdAt: input.message.createdAt,
    ciphertextHash: sha256Hex(input.encrypted.ciphertext),
  };
}

export function getPrivateChatEnvelopeSignableBytes(
  envelope: Omit<PrivateChatEnvelopeV1, 'signature'> | PrivateChatEnvelopeV1,
): string {
  return canonicalJson({
    version: envelope.version,
    type: envelope.type,
    algorithm: envelope.algorithm,
    messageId: envelope.messageId,
    senderId: envelope.senderId,
    recipientId: envelope.recipientId,
    createdAt: envelope.createdAt,
    ciphertext: envelope.ciphertext,
    nonce: envelope.nonce,
    ciphertextHash: envelope.ciphertextHash,
  });
}

export function createUnsignedChatDeliveryReceipt(input: {
  messageId: string;
  senderId: PeerId;
  recipientId: PeerId;
  deliveredAt: number;
}): Omit<ChatDeliveryReceiptV1, 'signature'> {
  return {
    version: 1,
    type: 'chat.delivery.receipt',
    messageId: input.messageId,
    senderId: input.senderId,
    recipientId: input.recipientId,
    deliveredAt: input.deliveredAt,
  };
}

export function getChatDeliveryReceiptSignableBytes(
  receipt: Omit<ChatDeliveryReceiptV1, 'signature'> | ChatDeliveryReceiptV1,
): string {
  return canonicalJson({
    version: receipt.version,
    type: receipt.type,
    messageId: receipt.messageId,
    senderId: receipt.senderId,
    recipientId: receipt.recipientId,
    deliveredAt: receipt.deliveredAt,
  });
}

export function createUnsignedChatReadReceipt(input: {
  messageId: string;
  senderId: PeerId;
  recipientId: PeerId;
  readAt: number;
}): Omit<ChatReadReceiptV1, 'signature'> {
  return {
    version: 1,
    type: 'chat.read.receipt',
    messageId: input.messageId,
    senderId: input.senderId,
    recipientId: input.recipientId,
    readAt: input.readAt,
  };
}

export function getChatReadReceiptSignableBytes(
  receipt: Omit<ChatReadReceiptV1, 'signature'> | ChatReadReceiptV1,
): string {
  return canonicalJson({
    version: receipt.version,
    type: receipt.type,
    messageId: receipt.messageId,
    senderId: receipt.senderId,
    recipientId: receipt.recipientId,
    readAt: receipt.readAt,
  });
}

export function isPrivateChatEnvelope(value: unknown): value is PrivateChatEnvelopeV1 {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.version === 1 &&
    value.type === 'chat.private.envelope' &&
    value.algorithm === 'x25519-aes-256-gcm' &&
    isNonEmptyString(value.messageId) &&
    isNonEmptyString(value.senderId) &&
    isNonEmptyString(value.recipientId) &&
    value.senderId !== value.recipientId &&
    isFiniteTimestamp(value.createdAt) &&
    isHex(value.ciphertext, 32) &&
    isHex(value.nonce, 24, 24) &&
    isHex(value.ciphertextHash, 64, 64) &&
    value.ciphertextHash === sha256Hex(value.ciphertext) &&
    isHex(value.signature, 64)
  );
}

export function isChatDeliveryReceipt(value: unknown): value is ChatDeliveryReceiptV1 {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.version === 1 &&
    value.type === 'chat.delivery.receipt' &&
    isNonEmptyString(value.messageId) &&
    isNonEmptyString(value.senderId) &&
    isNonEmptyString(value.recipientId) &&
    value.senderId !== value.recipientId &&
    isFiniteTimestamp(value.deliveredAt) &&
    isHex(value.signature, 64)
  );
}

export function isChatReadReceipt(value: unknown): value is ChatReadReceiptV1 {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.version === 1 &&
    value.type === 'chat.read.receipt' &&
    isNonEmptyString(value.messageId) &&
    isNonEmptyString(value.senderId) &&
    isNonEmptyString(value.recipientId) &&
    value.senderId !== value.recipientId &&
    isFiniteTimestamp(value.readAt) &&
    isHex(value.signature, 64)
  );
}

export function isChatReceipt(value: unknown): value is ChatReceiptV1 {
  return isChatDeliveryReceipt(value) || isChatReadReceipt(value);
}

export function parsePrivateChatMessage(serialized: string): ChatMessageData | null {
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed)) {
      return null;
    }
    if (
      !isNonEmptyString(parsed.id) ||
      !isNonEmptyString(parsed.author) ||
      !isFiniteTimestamp(parsed.createdAt) ||
      !isFiniteTimestamp(parsed.updatedAt) ||
      !isNonEmptyString(parsed.signature) ||
      !isNonEmptyString(parsed.version) ||
      !isNonEmptyString(parsed.conversationId) ||
      !isNonEmptyString(parsed.senderId) ||
      !isNonEmptyString(parsed.recipientId) ||
      typeof parsed.text !== 'string' ||
      !isNonEmptyString(parsed.contentHash) ||
      typeof parsed.deleted !== 'boolean'
    ) {
      return null;
    }
    if (
      (parsed.deliveredAt !== undefined && !isFiniteTimestamp(parsed.deliveredAt)) ||
      (parsed.readAt !== undefined && !isFiniteTimestamp(parsed.readAt)) ||
      (parsed.relayOnly !== undefined && typeof parsed.relayOnly !== 'boolean') ||
      !isValidRevisionMetadata(parsed.revision, parsed.previousRevisionHash)
    ) {
      return null;
    }
    return {
      id: parsed.id,
      author: parsed.author,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      signature: parsed.signature,
      version: parsed.version,
      revision: typeof parsed.revision === 'number' ? parsed.revision : undefined,
      previousRevisionHash:
        typeof parsed.previousRevisionHash === 'string' ? parsed.previousRevisionHash : undefined,
      conversationId: parsed.conversationId,
      senderId: parsed.senderId,
      recipientId: parsed.recipientId,
      text: parsed.text,
      contentHash: parsed.contentHash,
      deliveredAt: parsed.deliveredAt,
      readAt: parsed.readAt,
      relayOnly: parsed.relayOnly,
      deleted: parsed.deleted,
    };
  } catch {
    return null;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isValidRevisionMetadata(revision: unknown, previousRevisionHash: unknown): boolean {
  if (revision === undefined) {
    return previousRevisionHash === undefined;
  }
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    return false;
  }
  if (revision === 1) {
    return previousRevisionHash === undefined;
  }
  return typeof previousRevisionHash === 'string' && /^[0-9a-f]{64}$/i.test(previousRevisionHash);
}

function isHex(value: unknown, minLength: number, exactLength?: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= minLength &&
    (exactLength === undefined || value.length === exactLength) &&
    value.length % 2 === 0 &&
    /^[0-9a-f]+$/i.test(value)
  );
}
