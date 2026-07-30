import { AppError } from '@/errors/AppError';
import { sha256Hex } from '@/utils/hash';

import type { TransactionType } from '../RewardTypes';

export type TransactionStatusV2 =
  'created' | 'signed' | 'pending' | 'confirmed' | 'failed' | 'expired';

export interface TransactionFailure {
  code: string;
  reason: string;
  failedAt: number;
}

export interface TransactionPayload {
  amount: number;
  fee: number;
  metadata?: Record<string, unknown>;
  description?: string;
}

export interface TransactionBase {
  id: string;
  version: 1;
  type: TransactionType;
  senderId: string;
  recipientId: string;
  createdAt: number;
  expiresAt: number;
  nonce: string;
  sequence: number;
  payload: TransactionPayload;
  payloadHash: string;
  history: readonly TransactionHistoryEntry[];
}

export interface TransactionHistoryEntry {
  status: TransactionStatusV2;
  at: number;
  reason?: string;
}

export type CreatedTransaction = TransactionBase & { status: 'created' };
export type SignedTransaction = TransactionBase & {
  status: 'signed';
  signature: string;
  signedAt: number;
  publicKey?: string;
};
export type PendingTransaction = Omit<SignedTransaction, 'status'> & {
  status: 'pending';
  submittedAt: number;
};
export type ConfirmedTransaction = Omit<PendingTransaction, 'status'> & {
  status: 'confirmed';
  confirmedAt: number;
  confirmationReference?: string;
};
export type FailedTransaction = TransactionBase & {
  status: 'failed';
  signature?: string;
  signedAt?: number;
  publicKey?: string;
  submittedAt?: number;
  failure: TransactionFailure;
};
export type ExpiredTransaction = TransactionBase & {
  status: 'expired';
  signature?: string;
  signedAt?: number;
  publicKey?: string;
  submittedAt?: number;
  expiredAt: number;
};

export type CanonicalTransaction =
  | CreatedTransaction
  | SignedTransaction
  | PendingTransaction
  | ConfirmedTransaction
  | FailedTransaction
  | ExpiredTransaction;

export interface CreateTransactionInput {
  type: TransactionType;
  senderId: string;
  recipientId: string;
  amount: number;
  fee?: number;
  metadata?: Record<string, unknown>;
  description?: string;
  createdAt: number;
  expiresAt: number;
  nonce: string;
  sequence: number;
}

export function createCanonicalTransaction(input: CreateTransactionInput): CreatedTransaction {
  validateCreateTransactionInput(input);
  const payload: TransactionPayload = {
    amount: input.amount,
    fee: input.fee ?? 0,
    description: input.description,
    metadata: input.metadata,
  };
  const payloadHash = computeTransactionPayloadHash(payload);
  const id = computeTransactionId({
    version: 1,
    type: input.type,
    senderId: input.senderId,
    recipientId: input.recipientId,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    nonce: input.nonce,
    sequence: input.sequence,
    payloadHash,
  });

  return {
    id,
    version: 1,
    type: input.type,
    senderId: input.senderId,
    recipientId: input.recipientId,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    nonce: input.nonce,
    sequence: input.sequence,
    payload,
    payloadHash,
    status: 'created',
    history: [{ status: 'created', at: input.createdAt }],
  };
}

export function computeTransactionPayloadHash(payload: TransactionPayload): string {
  return sha256Hex(canonicalize(payload));
}

export function computeTransactionId(input: {
  version: 1;
  type: TransactionType;
  senderId: string;
  recipientId: string;
  createdAt: number;
  expiresAt: number;
  nonce: string;
  sequence: number;
  payloadHash: string;
}): string {
  return `tx_${sha256Hex(canonicalize(input)).slice(0, 48)}`;
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value));
}

export function getSignableTransactionBytes(transaction: CanonicalTransaction): string {
  return canonicalize({
    id: transaction.id,
    version: transaction.version,
    type: transaction.type,
    senderId: transaction.senderId,
    recipientId: transaction.recipientId,
    createdAt: transaction.createdAt,
    expiresAt: transaction.expiresAt,
    nonce: transaction.nonce,
    sequence: transaction.sequence,
    payloadHash: transaction.payloadHash,
  });
}

function validateCreateTransactionInput(input: CreateTransactionInput): void {
  if (input.amount <= 0 || !Number.isFinite(input.amount)) {
    throw transactionValidationError('Transaction amount must be a positive finite number');
  }
  if ((input.fee ?? 0) < 0 || !Number.isFinite(input.fee ?? 0)) {
    throw transactionValidationError('Transaction fee must be a non-negative finite number');
  }
  if (input.senderId.length === 0 || input.recipientId.length === 0) {
    throw transactionValidationError('Transaction sender and recipient are required');
  }
  if (input.senderId === input.recipientId) {
    throw transactionValidationError('Transaction sender and recipient must differ');
  }
  if (input.expiresAt <= input.createdAt) {
    throw transactionValidationError('Transaction expiration must be after creation');
  }
}

function toCanonicalValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw transactionValidationError('Non-finite numbers cannot be canonicalized');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toCanonicalValue);
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      result[key] = toCanonicalValue(record[key]);
    }
    return result;
  }

  throw transactionValidationError(`Unsupported canonical value type: ${typeof value}`);
}

function transactionValidationError(message: string): AppError {
  return new AppError({
    code: 'TRANSACTION_ERROR',
    message,
    safeMessage: 'A transacao e invalida.',
    severity: 'warning',
    retryable: false,
    context: {
      scope: 'wallet.transaction',
      operation: 'validate',
    },
  });
}
