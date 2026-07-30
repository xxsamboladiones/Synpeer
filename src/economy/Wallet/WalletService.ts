import type { PeerId } from '../../network/NetworkTypes';
import type { Wallet, Transaction, TransactionType } from '../RewardTypes';
import { WalletEvents } from './WalletEvents';
import { sha256Hex } from '../../utils/hash';
import type { Clock } from '../../time/Clock';
import { systemClock } from '../../time/Clock';
import { createCanonicalTransaction, type CanonicalTransaction } from './TransactionModel';
import { TransactionReplayProtector } from './TransactionReplayProtector';
import { CryptoTransactionSigner, LocalHashTransactionSigner } from './TransactionSigner';
import { TransactionStateMachine } from './TransactionStateMachine';
import { createLogger } from '../../observability/Logger';
import {
  CanonicalTransactionRepository,
  transactionPersistenceError,
} from './CanonicalTransactionRepository';
import type { CryptoService } from '../../crypto/CryptoService';

/**
 * Wallet Service manages local wallet operations
 */
export class WalletService {
  private wallet: Wallet | null = null;
  private transactions: Transaction[] = [];
  private events: WalletEvents;
  private canonicalTransactions: Map<string, CanonicalTransaction> = new Map();
  private replayProtector = new TransactionReplayProtector();
  private stateMachine: TransactionStateMachine;
  private signer: LocalHashTransactionSigner;
  private cryptoSigner?: CryptoTransactionSigner;
  private readonly logger = createLogger('wallet.service');

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly transactionRepository?: CanonicalTransactionRepository,
    cryptoService?: CryptoService,
  ) {
    this.events = new WalletEvents();
    this.stateMachine = new TransactionStateMachine(clock);
    this.signer = new LocalHashTransactionSigner(this.stateMachine);
    this.cryptoSigner = cryptoService
      ? new CryptoTransactionSigner(cryptoService, this.stateMachine)
      : undefined;
  }

  async initialize(): Promise<void> {
    if (!this.transactionRepository) {
      return;
    }
    await this.transactionRepository.initialize();
    const replaySnapshot = await this.transactionRepository.loadReplaySnapshot();
    if (replaySnapshot) {
      this.replayProtector.importSnapshot(replaySnapshot);
    }
    const transactions = await this.transactionRepository.listAll();
    this.canonicalTransactions.clear();
    for (const transaction of transactions) {
      this.canonicalTransactions.set(transaction.id, transaction);
    }
  }

  /**
   * Create a new wallet
   */
  createWallet(peerId: PeerId): Wallet {
    const address = this.generateAddress(peerId);
    const restoredTransactions = this.restoreLegacyTransactions(address);
    const createdAt =
      restoredTransactions.length > 0
        ? Math.min(...restoredTransactions.map((transaction) => transaction.timestamp))
        : this.clock.now();
    const updatedAt =
      restoredTransactions.length > 0
        ? Math.max(...restoredTransactions.map((transaction) => transaction.timestamp))
        : createdAt;
    const wallet: Wallet = {
      address,
      peerId,
      balance: this.calculateRestoredBalance(address),
      nonce: this.calculateRestoredNonce(),
      version: 1,
      createdAt,
      updatedAt,
    };

    this.wallet = wallet;
    this.transactions = restoredTransactions;
    this.events.emitWalletCreated(wallet.address, peerId);
    return wallet;
  }

  /**
   * Generate wallet address from peer ID
   */
  private generateAddress(peerId: PeerId): string {
    return `0x${sha256Hex(peerId).slice(0, 40)}`;
  }

  /**
   * Get wallet
   */
  getWallet(): Wallet | null {
    return this.wallet;
  }

  /**
   * Get wallet by peer ID
   */
  getWalletByPeerId(peerId: PeerId): Wallet | null {
    if (this.wallet?.peerId === peerId) {
      return this.wallet;
    }
    return null;
  }

  /**
   * Get wallet balance
   */
  getBalance(): number {
    return this.wallet?.balance ?? 0;
  }

  /**
   * Add balance
   */
  async addBalance(amount: number, type: TransactionType, description?: string): Promise<boolean> {
    if (!this.wallet) {
      return false;
    }

    if (amount <= 0) {
      return false;
    }

    this.wallet.balance += amount;
    this.wallet.nonce++;
    this.wallet.updatedAt = this.clock.now();

    const canonical = await this.createConfirmedCanonicalTransaction(
      'SYSTEM',
      this.wallet.address,
      amount,
      0,
      type,
      description,
    );
    const transaction: Transaction = {
      id: canonical.id,
      type,
      from: 'SYSTEM',
      to: this.wallet.address,
      amount,
      fee: 0,
      timestamp: canonical.createdAt,
      status: 'CONFIRMED',
      description,
      signature: canonical.status === 'confirmed' ? canonical.signature : undefined,
      metadata: this.legacyMetadata(canonical),
    };

    this.transactions.push(transaction);
    this.events.emitBalanceAdded(this.wallet.address, amount, this.wallet.balance);
    this.events.emitTransactionCreated(transaction);

    return true;
  }

  /**
   * Subtract balance
   */
  async subtractBalance(
    amount: number,
    type: TransactionType,
    description?: string,
  ): Promise<boolean> {
    if (!this.wallet) {
      return false;
    }

    if (amount <= 0) {
      return false;
    }

    if (this.wallet.balance < amount) {
      return false;
    }

    this.wallet.balance -= amount;
    this.wallet.nonce++;
    this.wallet.updatedAt = this.clock.now();

    const canonical = await this.createConfirmedCanonicalTransaction(
      this.wallet.address,
      'SYSTEM',
      amount,
      0,
      type,
      description,
    );
    const transaction: Transaction = {
      id: canonical.id,
      type,
      from: this.wallet.address,
      to: 'SYSTEM',
      amount,
      fee: 0,
      timestamp: canonical.createdAt,
      status: 'CONFIRMED',
      description,
      signature: canonical.status === 'confirmed' ? canonical.signature : undefined,
      metadata: this.legacyMetadata(canonical),
    };

    this.transactions.push(transaction);
    this.events.emitBalanceSubtracted(this.wallet.address, amount, this.wallet.balance);
    this.events.emitTransactionCreated(transaction);

    return true;
  }

  /**
   * Transfer balance
   */
  async transfer(toAddress: string, amount: number, fee: number = 0): Promise<boolean> {
    if (!this.wallet) {
      return false;
    }

    if (amount <= 0) {
      return false;
    }

    const totalAmount = amount + fee;
    if (this.wallet.balance < totalAmount) {
      return false;
    }

    this.wallet.balance -= totalAmount;
    this.wallet.nonce++;
    this.wallet.updatedAt = this.clock.now();

    const canonical = await this.createConfirmedCanonicalTransaction(
      this.wallet.address,
      toAddress,
      amount,
      fee,
      'TRANSFER',
    );
    const transaction: Transaction = {
      id: canonical.id,
      type: 'TRANSFER',
      from: this.wallet.address,
      to: toAddress,
      amount,
      fee,
      timestamp: canonical.createdAt,
      status: 'CONFIRMED',
      signature: canonical.status === 'confirmed' ? canonical.signature : undefined,
      metadata: this.legacyMetadata(canonical),
    };

    this.transactions.push(transaction);
    this.events.emitTransferInitiated(this.wallet.address, toAddress, amount);
    this.events.emitTransactionCreated(transaction);
    this.events.emitTransferCompleted(this.wallet.address, toAddress, amount);

    return true;
  }

  confirmTransaction(transactionId: string): boolean {
    const transaction = this.getTransaction(transactionId);
    if (!transaction || transaction.status === 'CONFIRMED') {
      return false;
    }

    const canonical = this.canonicalTransactions.get(transactionId);
    if (canonical) {
      const result = this.stateMachine.confirm(canonical);
      if (!result.applied && result.reason !== 'already-applied') {
        return false;
      }
      this.canonicalTransactions.set(transactionId, result.transaction);
      transaction.metadata = this.legacyMetadata(result.transaction);
    }

    transaction.status = 'CONFIRMED';
    if (transaction.type === 'TRANSFER') {
      this.events.emitTransferCompleted(transaction.from, transaction.to, transaction.amount);
    }
    return true;
  }

  failTransaction(transactionId: string, reason?: string): boolean {
    const transaction = this.getTransaction(transactionId);
    if (!transaction || transaction.status === 'CONFIRMED' || transaction.status === 'FAILED') {
      return false;
    }

    const canonical = this.canonicalTransactions.get(transactionId);
    if (canonical) {
      const result = this.stateMachine.fail(
        canonical,
        'TRANSACTION_FAILED',
        reason ?? 'Transaction failed',
      );
      if (!result.applied && result.reason !== 'already-applied') {
        return false;
      }
      this.canonicalTransactions.set(transactionId, result.transaction);
      transaction.metadata = this.legacyMetadata(result.transaction);
    }

    transaction.status = 'FAILED';
    transaction.metadata = {
      ...transaction.metadata,
      failureReason: reason ?? 'Transaction failed',
    };
    return true;
  }

  private async createConfirmedCanonicalTransaction(
    from: string,
    to: string,
    amount: number,
    fee: number,
    type: TransactionType,
    description?: string,
  ): Promise<CanonicalTransaction> {
    if (!this.wallet) {
      throw new Error('Wallet not initialized');
    }

    const createdAt = this.clock.now();
    const sequence = this.wallet.nonce;
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
    const signed =
      this.cryptoSigner && from === this.wallet.address
        ? await this.cryptoSigner.sign(canonical)
        : this.signer.sign(canonical, this.wallet.address, this.wallet.address);
    const pendingResult = this.stateMachine.markPending(signed);
    if (!pendingResult.applied || pendingResult.transaction.status !== 'pending') {
      throw new Error('Failed to mark transaction pending');
    }
    const confirmResult = this.stateMachine.confirm(
      pendingResult.transaction,
      `local:${canonical.id}`,
    );
    if (!confirmResult.applied) {
      throw new Error(`Failed to confirm transaction: ${confirmResult.reason}`);
    }
    const replay = this.replayProtector.record(confirmResult.transaction);
    if (!replay.accepted) {
      throw new Error(`Transaction replay detected: ${replay.reason}`);
    }
    this.canonicalTransactions.set(confirmResult.transaction.id, confirmResult.transaction);
    await this.persistCanonicalState(confirmResult.transaction);
    return confirmResult.transaction;
  }

  private async persistCanonicalState(transaction: CanonicalTransaction): Promise<void> {
    if (!this.transactionRepository) {
      return;
    }
    try {
      await this.transactionRepository.save(transaction, this.clock.now());
      await this.transactionRepository.saveReplaySnapshot(
        this.replayProtector.exportSnapshot(),
        this.clock.now(),
      );
    } catch (error) {
      throw transactionPersistenceError(error);
    }
  }

  private generateNonce(senderId: string, sequence: number): string {
    return sha256Hex(`${senderId}:${sequence}`).slice(0, 32);
  }

  private restoreLegacyTransactions(walletAddress: string): Transaction[] {
    return Array.from(this.canonicalTransactions.values())
      .filter(
        (transaction) =>
          transaction.senderId === walletAddress || transaction.recipientId === walletAddress,
      )
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((transaction) => ({
        id: transaction.id,
        type: transaction.type,
        from: transaction.senderId,
        to: transaction.recipientId,
        amount: transaction.payload.amount,
        fee: transaction.payload.fee,
        timestamp: transaction.createdAt,
        status: toLegacyStatus(transaction.status),
        description: transaction.payload.description,
        signature: 'signature' in transaction ? transaction.signature : undefined,
        metadata: this.legacyMetadata(transaction),
      }));
  }

  private calculateRestoredBalance(walletAddress: string): number {
    let balance = 0;
    for (const transaction of this.canonicalTransactions.values()) {
      if (transaction.status !== 'confirmed') {
        continue;
      }
      if (transaction.recipientId === walletAddress) {
        balance += transaction.payload.amount;
      }
      if (transaction.senderId === walletAddress) {
        balance -= transaction.payload.amount + transaction.payload.fee;
      }
    }
    return Math.max(0, balance);
  }

  private calculateRestoredNonce(): number {
    let maxSequence = 0;
    for (const transaction of this.canonicalTransactions.values()) {
      maxSequence = Math.max(maxSequence, transaction.sequence);
    }
    return maxSequence;
  }

  private legacyMetadata(transaction: CanonicalTransaction): Record<string, unknown> {
    return {
      canonicalStatus: transaction.status,
      payloadHash: transaction.payloadHash,
      nonce: transaction.nonce,
      sequence: transaction.sequence,
      history: transaction.history,
      ...(transaction.status === 'failed' ? { failure: transaction.failure } : {}),
      ...(transaction.status === 'confirmed' ? { confirmedAt: transaction.confirmedAt } : {}),
    };
  }

  /**
   * Get transactions
   */
  getTransactions(limit?: number): Transaction[] {
    if (limit) {
      return this.transactions.slice(-limit);
    }
    return this.transactions;
  }

  /**
   * Get transactions by type
   */
  getTransactionsByType(type: TransactionType): Transaction[] {
    return this.transactions.filter((t) => t.type === type);
  }

  /**
   * Get transaction by ID
   */
  getTransaction(id: string): Transaction | null {
    return this.transactions.find((t) => t.id === id) || null;
  }

  /**
   * Get transaction count
   */
  getTransactionCount(): number {
    return this.transactions.length;
  }

  /**
   * Get wallet events
   */
  getEvents(): WalletEvents {
    return this.events;
  }

  /**
   * Clear wallet
   */
  clearWallet(): void {
    this.wallet = null;
    this.transactions = [];
  }

  /**
   * Export wallet to JSON
   */
  exportToJSON(): string {
    return JSON.stringify(
      {
        wallet: this.wallet,
        transactions: this.transactions,
      },
      null,
      2,
    );
  }

  /**
   * Import wallet from JSON
   */
  importFromJSON(json: string): void {
    try {
      const data = JSON.parse(json) as {
        wallet?: Wallet;
        transactions?: Transaction[];
      };

      if (data.wallet) {
        this.wallet = data.wallet;
      }

      if (data.transactions) {
        this.transactions = data.transactions;
        this.canonicalTransactions.clear();
      }
    } catch (error) {
      this.logger.error('import_failed', error);
    }
  }

  /**
   * Get wallet statistics
   */
  getStatistics(): {
    balance: number;
    transactionCount: number;
    totalReceived: number;
    totalSent: number;
    totalFees: number;
    averageTransactionAmount: number;
  } {
    if (!this.wallet) {
      return {
        balance: 0,
        transactionCount: 0,
        totalReceived: 0,
        totalSent: 0,
        totalFees: 0,
        averageTransactionAmount: 0,
      };
    }

    const totalReceived = this.transactions
      .filter((t) => t.to === this.wallet?.address)
      .reduce((sum, t) => sum + t.amount, 0);

    const totalSent = this.transactions
      .filter((t) => t.from === this.wallet?.address)
      .reduce((sum, t) => sum + t.amount, 0);

    const totalFees = this.transactions.reduce((sum, t) => sum + t.fee, 0);

    const averageTransactionAmount =
      this.transactions.length > 0
        ? this.transactions.reduce((sum, t) => sum + t.amount, 0) / this.transactions.length
        : 0;

    return {
      balance: this.wallet.balance,
      transactionCount: this.transactions.length,
      totalReceived,
      totalSent,
      totalFees,
      averageTransactionAmount,
    };
  }
}

function toLegacyStatus(status: CanonicalTransaction['status']): Transaction['status'] {
  switch (status) {
    case 'created':
    case 'signed':
    case 'pending':
      return 'PENDING';
    case 'confirmed':
      return 'CONFIRMED';
    case 'failed':
    case 'expired':
      return 'FAILED';
  }
}
