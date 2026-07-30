import { AppError } from '@/errors/AppError';
import type { Clock } from '@/time/Clock';
import { systemClock } from '@/time/Clock';

import type {
  CanonicalTransaction,
  ConfirmedTransaction,
  CreatedTransaction,
  FailedTransaction,
  PendingTransaction,
  SignedTransaction,
  TransactionStatusV2,
} from './TransactionModel';

export type TransactionTransitionResult =
  | {
      applied: true;
      transaction: CanonicalTransaction;
      previousStatus: TransactionStatusV2;
    }
  | {
      applied: false;
      reason: 'already-applied' | 'invalid-transition' | 'conflict' | 'expired';
      transaction: CanonicalTransaction;
    };

export class TransactionStateMachine {
  constructor(private readonly clock: Clock = systemClock) {}

  sign(
    transaction: CanonicalTransaction,
    signature: string,
    publicKey?: string,
  ): TransactionTransitionResult {
    if (transaction.status === 'signed') {
      return { applied: false, reason: 'already-applied', transaction };
    }
    if (transaction.status !== 'created') {
      return { applied: false, reason: 'invalid-transition', transaction };
    }
    if (this.isExpired(transaction)) {
      return this.expire(transaction);
    }
    if (signature.trim().length === 0) {
      throw this.invalidStateError('Transaction signature is required');
    }

    const signed: SignedTransaction = {
      ...transaction,
      status: 'signed',
      signature,
      publicKey,
      signedAt: this.clock.now(),
      history: appendHistory(transaction, 'signed', this.clock.now()),
    };

    return { applied: true, previousStatus: transaction.status, transaction: signed };
  }

  markPending(transaction: CanonicalTransaction): TransactionTransitionResult {
    if (transaction.status === 'pending') {
      return { applied: false, reason: 'already-applied', transaction };
    }
    if (transaction.status !== 'signed') {
      return { applied: false, reason: 'invalid-transition', transaction };
    }
    if (this.isExpired(transaction)) {
      return this.expire(transaction);
    }

    const pending: PendingTransaction = {
      ...transaction,
      status: 'pending',
      submittedAt: this.clock.now(),
      history: appendHistory(transaction, 'pending', this.clock.now()),
    };
    return { applied: true, previousStatus: transaction.status, transaction: pending };
  }

  confirm(
    transaction: CanonicalTransaction,
    confirmationReference?: string,
  ): TransactionTransitionResult {
    if (transaction.status === 'confirmed') {
      if (transaction.confirmationReference === confirmationReference) {
        return { applied: false, reason: 'already-applied', transaction };
      }
      return { applied: false, reason: 'conflict', transaction };
    }
    if (transaction.status === 'expired') {
      return { applied: false, reason: 'expired', transaction };
    }
    if (transaction.status !== 'pending') {
      return { applied: false, reason: 'invalid-transition', transaction };
    }
    if (this.isExpired(transaction)) {
      return this.expire(transaction);
    }

    const confirmed: ConfirmedTransaction = {
      ...transaction,
      status: 'confirmed',
      confirmedAt: this.clock.now(),
      confirmationReference,
      history: appendHistory(transaction, 'confirmed', this.clock.now()),
    };
    return { applied: true, previousStatus: transaction.status, transaction: confirmed };
  }

  fail(
    transaction: CanonicalTransaction,
    code: string,
    reason: string,
  ): TransactionTransitionResult {
    if (transaction.status === 'failed') {
      if (transaction.failure.code === code && transaction.failure.reason === reason) {
        return { applied: false, reason: 'already-applied', transaction };
      }
      return { applied: false, reason: 'conflict', transaction };
    }
    if (transaction.status === 'confirmed' || transaction.status === 'expired') {
      return { applied: false, reason: 'invalid-transition', transaction };
    }

    const failed: FailedTransaction = {
      ...transaction,
      status: 'failed',
      failure: {
        code,
        reason,
        failedAt: this.clock.now(),
      },
      history: appendHistory(transaction, 'failed', this.clock.now(), reason),
    };
    return { applied: true, previousStatus: transaction.status, transaction: failed };
  }

  expire(transaction: CanonicalTransaction): TransactionTransitionResult {
    if (transaction.status === 'expired') {
      return { applied: false, reason: 'already-applied', transaction };
    }
    if (transaction.status === 'confirmed' || transaction.status === 'failed') {
      return { applied: false, reason: 'invalid-transition', transaction };
    }
    if (!this.isExpired(transaction)) {
      return { applied: false, reason: 'invalid-transition', transaction };
    }

    const expired = {
      ...transaction,
      status: 'expired' as const,
      expiredAt: this.clock.now(),
      history: appendHistory(transaction, 'expired', this.clock.now()),
    };
    return { applied: true, previousStatus: transaction.status, transaction: expired };
  }

  private isExpired(transaction: Pick<CreatedTransaction, 'expiresAt'>): boolean {
    return transaction.expiresAt <= this.clock.now();
  }

  private invalidStateError(message: string): AppError {
    return new AppError({
      code: 'TRANSACTION_ERROR',
      message,
      safeMessage: 'A transacao nao pode mudar para esse estado.',
      severity: 'warning',
      retryable: false,
      context: {
        scope: 'wallet.transaction',
        operation: 'transition',
      },
    });
  }
}

function appendHistory(
  transaction: CanonicalTransaction,
  status: TransactionStatusV2,
  at: number,
  reason?: string,
) {
  return [...transaction.history, { status, at, reason }];
}
