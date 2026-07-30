import type { Transaction, TransactionStatus, TransactionType } from '../RewardTypes';
import { sha256Hex } from '../../utils/hash';
import type { Clock } from '../../time/Clock';
import { systemClock } from '../../time/Clock';
import {
  createCanonicalTransaction,
  type CanonicalTransaction,
  type SignedTransaction,
} from './TransactionModel';
import { TransactionStateMachine } from './TransactionStateMachine';

/**
 * Compatibility facade for older callers. New code should prefer
 * CanonicalTransactionRepository + TransactionStateMachine directly.
 */
export class TransactionManager {
  private transactions: Map<string, Transaction> = new Map();
  private canonicalTransactions: Map<string, CanonicalTransaction> = new Map();
  private pendingTransactions: Map<string, Transaction> = new Map();
  private stateMachine: TransactionStateMachine;

  constructor(private readonly clock: Clock = systemClock) {
    this.stateMachine = new TransactionStateMachine(clock);
  }

  async createTransaction(
    from: string,
    to: string,
    amount: number,
    type: TransactionType,
    fee: number = 0,
    description?: string,
    signature?: string,
  ): Promise<Transaction> {
    const createdAt = this.clock.now();
    const sequence = this.getNextSequence(from);
    const canonical = createCanonicalTransaction({
      type,
      senderId: from,
      recipientId: to,
      amount,
      fee,
      description,
      createdAt,
      expiresAt: createdAt + 60 * 60 * 1000,
      nonce: this.generateNonce(from, sequence),
      sequence,
    });

    const signedResult = signature ? this.stateMachine.sign(canonical, signature, from) : null;
    const storedCanonical = signedResult?.applied ? signedResult.transaction : canonical;
    const pendingResult =
      storedCanonical.status === 'signed' ? this.stateMachine.markPending(storedCanonical) : null;
    const finalCanonical = pendingResult?.applied ? pendingResult.transaction : storedCanonical;

    this.canonicalTransactions.set(finalCanonical.id, finalCanonical);

    const transaction = this.toLegacyTransaction(finalCanonical);
    this.transactions.set(transaction.id, transaction);
    if (transaction.status === 'PENDING') {
      this.pendingTransactions.set(transaction.id, transaction);
    }

    return transaction;
  }

  signTransaction(transactionId: string, signature: string): boolean {
    const canonical = this.canonicalTransactions.get(transactionId);
    if (!canonical) {
      return false;
    }

    const signed = this.stateMachine.sign(canonical, signature, canonical.senderId);
    if (!signed.applied && signed.reason !== 'already-applied') {
      return false;
    }
    const pending =
      signed.transaction.status === 'signed'
        ? this.stateMachine.markPending(signed.transaction)
        : signed;
    const next = pending.applied ? pending.transaction : signed.transaction;
    this.canonicalTransactions.set(transactionId, next);
    this.updateLegacy(next);
    return true;
  }

  validateTransaction(transaction: Transaction): boolean {
    return (
      transaction.amount > 0 &&
      transaction.fee >= 0 &&
      transaction.from !== transaction.to &&
      (transaction.type === 'REWARD' ||
        transaction.type === 'PENALTY' ||
        Boolean(transaction.signature))
    );
  }

  confirmTransaction(transactionId: string): boolean {
    const canonical = this.canonicalTransactions.get(transactionId);
    if (!canonical) {
      return false;
    }
    const result = this.stateMachine.confirm(canonical, `legacy:${transactionId}`);
    if (!result.applied && result.reason !== 'already-applied') {
      return false;
    }
    this.canonicalTransactions.set(transactionId, result.transaction);
    this.pendingTransactions.delete(transactionId);
    this.updateLegacy(result.transaction);
    return result.applied;
  }

  failTransaction(transactionId: string, reason?: string): boolean {
    const canonical = this.canonicalTransactions.get(transactionId);
    if (!canonical) {
      return false;
    }
    const result = this.stateMachine.fail(
      canonical,
      'TRANSACTION_FAILED',
      reason ?? 'Transaction failed',
    );
    if (!result.applied && result.reason !== 'already-applied') {
      return false;
    }
    this.canonicalTransactions.set(transactionId, result.transaction);
    this.pendingTransactions.delete(transactionId);
    this.updateLegacy(result.transaction);
    return result.applied;
  }

  cancelTransaction(transactionId: string): boolean {
    return this.failTransaction(transactionId, 'Transaction cancelled');
  }

  getTransaction(id: string): Transaction | null {
    return this.transactions.get(id) || null;
  }

  getTransactionsForAddress(address: string, limit?: number): Transaction[] {
    const addressTransactions = Array.from(this.transactions.values()).filter(
      (transaction) => transaction.from === address || transaction.to === address,
    );
    return limit ? addressTransactions.slice(-limit) : addressTransactions;
  }

  getTransactionsByType(type: TransactionType, limit?: number): Transaction[] {
    const typeTransactions = Array.from(this.transactions.values()).filter(
      (transaction) => transaction.type === type,
    );
    return limit ? typeTransactions.slice(-limit) : typeTransactions;
  }

  getTransactionsByStatus(status: TransactionStatus, limit?: number): Transaction[] {
    const statusTransactions = Array.from(this.transactions.values()).filter(
      (transaction) => transaction.status === status,
    );
    return limit ? statusTransactions.slice(-limit) : statusTransactions;
  }

  getPendingTransactions(): Transaction[] {
    return Array.from(this.pendingTransactions.values());
  }

  getAllTransactions(limit?: number): Transaction[] {
    const allTransactions = Array.from(this.transactions.values());
    return limit ? allTransactions.slice(-limit) : allTransactions;
  }

  getCount(): number {
    return this.transactions.size;
  }

  getPendingCount(): number {
    return this.pendingTransactions.size;
  }

  clearAll(): void {
    this.transactions.clear();
    this.canonicalTransactions.clear();
    this.pendingTransactions.clear();
  }

  clearPending(): void {
    this.pendingTransactions.clear();
  }

  exportToJSON(): string {
    return JSON.stringify(Array.from(this.canonicalTransactions.values()), null, 2);
  }

  importFromJSON(json: string): void {
    const transactions = JSON.parse(json) as CanonicalTransaction[];
    this.clearAll();
    for (const transaction of transactions) {
      if (!isCanonicalTransaction(transaction)) {
        continue;
      }
      this.canonicalTransactions.set(transaction.id, transaction);
      const legacy = this.toLegacyTransaction(transaction);
      this.transactions.set(legacy.id, legacy);
      if (legacy.status === 'PENDING') {
        this.pendingTransactions.set(legacy.id, legacy);
      }
    }
  }

  getStatistics(): {
    totalTransactions: number;
    pendingTransactions: number;
    confirmedTransactions: number;
    failedTransactions: number;
    cancelledTransactions: number;
    totalAmount: number;
    totalFees: number;
    byType: Map<TransactionType, number>;
  } {
    const transactions = Array.from(this.transactions.values());
    return {
      totalTransactions: transactions.length,
      pendingTransactions: this.pendingTransactions.size,
      confirmedTransactions: transactions.filter(
        (transaction) => transaction.status === 'CONFIRMED',
      ).length,
      failedTransactions: transactions.filter((transaction) => transaction.status === 'FAILED')
        .length,
      cancelledTransactions: transactions.filter(
        (transaction) => transaction.status === 'CANCELLED',
      ).length,
      totalAmount: transactions.reduce((sum, transaction) => sum + transaction.amount, 0),
      totalFees: transactions.reduce((sum, transaction) => sum + transaction.fee, 0),
      byType: transactions.reduce((counts, transaction) => {
        counts.set(transaction.type, (counts.get(transaction.type) ?? 0) + 1);
        return counts;
      }, new Map<TransactionType, number>()),
    };
  }

  private updateLegacy(transaction: CanonicalTransaction): void {
    const legacy = this.toLegacyTransaction(transaction);
    this.transactions.set(legacy.id, legacy);
    if (legacy.status === 'PENDING') {
      this.pendingTransactions.set(legacy.id, legacy);
    }
  }

  private toLegacyTransaction(transaction: CanonicalTransaction): Transaction {
    return {
      id: transaction.id,
      type: transaction.type,
      from: transaction.senderId,
      to: transaction.recipientId,
      amount: transaction.payload.amount,
      fee: transaction.payload.fee,
      timestamp: transaction.createdAt,
      status: toLegacyStatus(transaction.status),
      description: transaction.payload.description,
      signature: isSigned(transaction) ? transaction.signature : undefined,
      metadata: {
        canonicalStatus: transaction.status,
        payloadHash: transaction.payloadHash,
        nonce: transaction.nonce,
        sequence: transaction.sequence,
      },
    };
  }

  private getNextSequence(senderId: string): number {
    const senderTransactions = Array.from(this.canonicalTransactions.values()).filter(
      (transaction) => transaction.senderId === senderId,
    );
    return (
      senderTransactions.reduce((max, transaction) => Math.max(max, transaction.sequence), 0) + 1
    );
  }

  private generateNonce(senderId: string, sequence: number): string {
    return sha256Hex(`${senderId}:${sequence}`).slice(0, 32);
  }
}

function toLegacyStatus(status: CanonicalTransaction['status']): TransactionStatus {
  switch (status) {
    case 'confirmed':
      return 'CONFIRMED';
    case 'failed':
      return 'FAILED';
    case 'expired':
      return 'CANCELLED';
    default:
      return 'PENDING';
  }
}

function isSigned(transaction: CanonicalTransaction): transaction is SignedTransaction {
  return 'signature' in transaction && typeof transaction.signature === 'string';
}

function isCanonicalTransaction(value: unknown): value is CanonicalTransaction {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const transaction = value as Record<string, unknown>;
  return (
    typeof transaction.id === 'string' &&
    transaction.version === 1 &&
    typeof transaction.senderId === 'string' &&
    typeof transaction.recipientId === 'string' &&
    typeof transaction.payloadHash === 'string' &&
    typeof transaction.status === 'string'
  );
}
