import { sha256Hex } from '@/utils/hash';
import type { CanonicalTransaction, SignedTransaction } from './TransactionModel';
import { getSignableTransactionBytes } from './TransactionModel';
import { TransactionStateMachine } from './TransactionStateMachine';

export interface TransactionSigner {
  sign(
    transaction: CanonicalTransaction,
    signerSecret: string,
    publicKey?: string,
  ): SignedTransaction;
  verify(transaction: CanonicalTransaction, signerSecret: string): boolean;
}

export class LocalHashTransactionSigner implements TransactionSigner {
  private readonly stateMachine: TransactionStateMachine;

  constructor(stateMachine = new TransactionStateMachine()) {
    this.stateMachine = stateMachine;
  }

  sign(
    transaction: CanonicalTransaction,
    signerSecret: string,
    publicKey?: string,
  ): SignedTransaction {
    const signature = this.createSignature(transaction, signerSecret);
    const result = this.stateMachine.sign(transaction, signature, publicKey);
    if (!result.applied || result.transaction.status !== 'signed') {
      throw new Error('Transaction could not be signed');
    }
    return result.transaction;
  }

  verify(transaction: CanonicalTransaction, signerSecret: string): boolean {
    if (
      !('signature' in transaction) ||
      typeof transaction.signature !== 'string' ||
      transaction.signature.trim().length === 0
    ) {
      return false;
    }
    return transaction.signature === this.createSignature(transaction, signerSecret);
  }

  private createSignature(transaction: CanonicalTransaction, signerSecret: string): string {
    return sha256Hex(`${signerSecret}:${getSignableTransactionBytes(transaction)}`);
  }
}

export interface TransactionCryptoProvider {
  sign(data: string): Promise<string>;
  verify(data: string, signature: string, publicIdentity: string): Promise<boolean>;
  getPublicIdentity(): string | null;
}

export class CryptoTransactionSigner {
  constructor(
    private readonly cryptoService: TransactionCryptoProvider,
    private readonly stateMachine = new TransactionStateMachine(),
  ) {}

  async sign(transaction: CanonicalTransaction): Promise<SignedTransaction> {
    const signature = await this.cryptoService.sign(getSignableTransactionBytes(transaction));
    const publicKey = this.cryptoService.getPublicIdentity() ?? undefined;
    const result = this.stateMachine.sign(transaction, signature, publicKey);
    if (!result.applied || result.transaction.status !== 'signed') {
      throw new Error('Transaction could not be signed cryptographically');
    }
    return result.transaction;
  }

  async verify(transaction: CanonicalTransaction): Promise<boolean> {
    if (!('signature' in transaction) || typeof transaction.signature !== 'string') {
      return false;
    }
    if (
      !transaction.publicKey ||
      !senderMatchesPublicKey(transaction.senderId, transaction.publicKey)
    ) {
      return false;
    }
    return await this.cryptoService.verify(
      getSignableTransactionBytes(transaction),
      transaction.signature,
      transaction.publicKey,
    );
  }
}

function senderMatchesPublicKey(senderId: string, publicKey: string): boolean {
  return senderId === publicKey || senderId === `0x${sha256Hex(publicKey).slice(0, 40)}`;
}
