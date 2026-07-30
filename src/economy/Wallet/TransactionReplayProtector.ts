import type { CanonicalTransaction } from './TransactionModel';

export type ReplayCheckResult =
  | { accepted: true }
  | { accepted: false; reason: 'duplicate-id' | 'nonce-reused' | 'sequence-regression' };

export interface ReplayProtectorSnapshot {
  processedIds: string[];
  nonceBySender: Array<[string, string[]]>;
  sequenceBySender: Array<[string, number]>;
}

export class TransactionReplayProtector {
  private readonly processedIds = new Set<string>();
  private readonly nonceBySender = new Map<string, Set<string>>();
  private readonly sequenceBySender = new Map<string, number>();

  check(transaction: CanonicalTransaction): ReplayCheckResult {
    if (this.processedIds.has(transaction.id)) {
      return { accepted: false, reason: 'duplicate-id' };
    }

    const senderNonces = this.nonceBySender.get(transaction.senderId);
    if (senderNonces?.has(transaction.nonce)) {
      return { accepted: false, reason: 'nonce-reused' };
    }

    const lastSequence = this.sequenceBySender.get(transaction.senderId);
    if (lastSequence !== undefined && transaction.sequence < lastSequence) {
      return { accepted: false, reason: 'sequence-regression' };
    }

    return { accepted: true };
  }

  record(transaction: CanonicalTransaction): ReplayCheckResult {
    const result = this.check(transaction);
    if (!result.accepted) {
      return result;
    }

    this.processedIds.add(transaction.id);
    const senderNonces = this.nonceBySender.get(transaction.senderId) ?? new Set<string>();
    senderNonces.add(transaction.nonce);
    this.nonceBySender.set(transaction.senderId, senderNonces);
    this.sequenceBySender.set(
      transaction.senderId,
      Math.max(
        transaction.sequence,
        this.sequenceBySender.get(transaction.senderId) ?? transaction.sequence,
      ),
    );
    return { accepted: true };
  }

  exportSnapshot(): ReplayProtectorSnapshot {
    return {
      processedIds: [...this.processedIds].sort(),
      nonceBySender: [...this.nonceBySender.entries()]
        .map(([sender, nonces]) => [sender, [...nonces].sort()] as [string, string[]])
        .sort(([left], [right]) => left.localeCompare(right)),
      sequenceBySender: [...this.sequenceBySender.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    };
  }

  importSnapshot(snapshot: ReplayProtectorSnapshot): void {
    this.processedIds.clear();
    this.nonceBySender.clear();
    this.sequenceBySender.clear();

    for (const id of snapshot.processedIds) {
      this.processedIds.add(id);
    }
    for (const [sender, nonces] of snapshot.nonceBySender) {
      this.nonceBySender.set(sender, new Set(nonces));
    }
    for (const [sender, sequence] of snapshot.sequenceBySender) {
      this.sequenceBySender.set(sender, sequence);
    }
  }

  clear(): void {
    this.processedIds.clear();
    this.nonceBySender.clear();
    this.sequenceBySender.clear();
  }
}
