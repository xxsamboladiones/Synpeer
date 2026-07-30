import type { PeerId } from '../../network/NetworkTypes';

/**
 * Wallet event types
 */
export type WalletEventType =
  | 'WALLET_CREATED'
  | 'BALANCE_ADDED'
  | 'BALANCE_SUBTRACTED'
  | 'TRANSFER_INITIATED'
  | 'TRANSFER_COMPLETED'
  | 'TRANSACTION_CREATED'
  | 'WALLET_UPDATED';

/**
 * Base wallet event
 */
export interface WalletEvent {
  id: string;
  type: WalletEventType;
  walletAddress: string;
  peerId?: PeerId;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * Wallet created event
 */
export interface WalletCreatedEvent extends WalletEvent {
  type: 'WALLET_CREATED';
  peerId: PeerId;
}

/**
 * Balance added event
 */
export interface BalanceAddedEvent extends WalletEvent {
  type: 'BALANCE_ADDED';
  amount: number;
  newBalance: number;
}

/**
 * Balance subtracted event
 */
export interface BalanceSubtractedEvent extends WalletEvent {
  type: 'BALANCE_SUBTRACTED';
  amount: number;
  newBalance: number;
}

/**
 * Transfer initiated event
 */
export interface TransferInitiatedEvent extends WalletEvent {
  type: 'TRANSFER_INITIATED';
  toAddress: string;
  amount: number;
}

/**
 * Transfer completed event
 */
export interface TransferCompletedEvent extends WalletEvent {
  type: 'TRANSFER_COMPLETED';
  toAddress: string;
  amount: number;
}

/**
 * Transaction created event
 */
export interface TransactionCreatedEvent extends WalletEvent {
  type: 'TRANSACTION_CREATED';
  transactionId: string;
  transactionType: string;
  amount: number;
}

/**
 * Wallet Events manages wallet event emission
 */
export class WalletEvents {
  private events: WalletEvent[] = [];
  private listeners: Map<WalletEventType, Set<(event: WalletEvent) => void>> = new Map();
  private allListeners: Set<(event: WalletEvent) => void> = new Set();
  private eventCounter: number = 0;

  /**
   * Emit a wallet event
   */
  emit(
    type: WalletEventType,
    walletAddress: string,
    peerId?: PeerId,
    metadata?: Record<string, unknown>,
  ): WalletEvent {
    this.eventCounter++;

    const event: WalletEvent = {
      id: `wallet_event_${Date.now()}_${this.eventCounter}`,
      type,
      walletAddress,
      peerId,
      timestamp: Date.now(),
      metadata,
    };

    this.events.push(event);

    // Notify type-specific listeners
    const typeListeners = this.listeners.get(type);
    if (typeListeners) {
      for (const listener of typeListeners) {
        try {
          listener(event);
        } catch (error) {
          console.error('[WalletEvents] Error in listener:', error);
        }
      }
    }

    // Notify all listeners
    for (const listener of this.allListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[WalletEvents] Error in listener:', error);
      }
    }

    return event;
  }

  /**
   * Emit wallet created event
   */
  emitWalletCreated(walletAddress: string, peerId: PeerId): WalletCreatedEvent {
    const event = this.emit('WALLET_CREATED', walletAddress, peerId) as WalletCreatedEvent;
    return event;
  }

  /**
   * Emit balance added event
   */
  emitBalanceAdded(walletAddress: string, amount: number, newBalance: number): BalanceAddedEvent {
    const event = this.emit('BALANCE_ADDED', walletAddress, undefined, {
      amount,
      newBalance,
    }) as BalanceAddedEvent;
    return event;
  }

  /**
   * Emit balance subtracted event
   */
  emitBalanceSubtracted(
    walletAddress: string,
    amount: number,
    newBalance: number,
  ): BalanceSubtractedEvent {
    const event = this.emit('BALANCE_SUBTRACTED', walletAddress, undefined, {
      amount,
      newBalance,
    }) as BalanceSubtractedEvent;
    return event;
  }

  /**
   * Emit transfer initiated event
   */
  emitTransferInitiated(
    walletAddress: string,
    toAddress: string,
    amount: number,
  ): TransferInitiatedEvent {
    const event = this.emit('TRANSFER_INITIATED', walletAddress, undefined, {
      toAddress,
      amount,
    }) as TransferInitiatedEvent;
    return event;
  }

  /**
   * Emit transfer completed event
   */
  emitTransferCompleted(
    walletAddress: string,
    toAddress: string,
    amount: number,
  ): TransferCompletedEvent {
    const event = this.emit('TRANSFER_COMPLETED', walletAddress, undefined, {
      toAddress,
      amount,
    }) as TransferCompletedEvent;
    return event;
  }

  /**
   * Emit transaction created event
   */
  emitTransactionCreated(transaction: {
    id: string;
    type: string;
    amount: number;
  }): TransactionCreatedEvent {
    const event = this.emit('TRANSACTION_CREATED', transaction.id, undefined, {
      transactionId: transaction.id,
      transactionType: transaction.type,
      amount: transaction.amount,
    }) as TransactionCreatedEvent;
    return event;
  }

  /**
   * Add listener for specific event type
   */
  on(type: WalletEventType, listener: (event: WalletEvent) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  /**
   * Add listener for all events
   */
  onAll(listener: (event: WalletEvent) => void): void {
    this.allListeners.add(listener);
  }

  /**
   * Remove listener for specific event type
   */
  off(type: WalletEventType, listener: (event: WalletEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  /**
   * Remove listener for all events
   */
  offAll(listener: (event: WalletEvent) => void): void {
    this.allListeners.delete(listener);
  }

  /**
   * Get events for a wallet
   */
  getEventsForWallet(walletAddress: string, limit?: number): WalletEvent[] {
    const walletEvents = this.events.filter((e) => e.walletAddress === walletAddress);
    if (limit) {
      return walletEvents.slice(-limit);
    }
    return walletEvents;
  }

  /**
   * Get events by type
   */
  getEventsByType(type: WalletEventType, limit?: number): WalletEvent[] {
    const typeEvents = this.events.filter((e) => e.type === type);
    if (limit) {
      return typeEvents.slice(-limit);
    }
    return typeEvents;
  }

  /**
   * Get all events
   */
  getAllEvents(limit?: number): WalletEvent[] {
    if (limit) {
      return this.events.slice(-limit);
    }
    return this.events;
  }

  /**
   * Clear all events
   */
  clearAll(): void {
    this.events = [];
  }

  /**
   * Clear events for a wallet
   */
  clearForWallet(walletAddress: string): void {
    this.events = this.events.filter((e) => e.walletAddress !== walletAddress);
  }

  /**
   * Get total event count
   */
  getCount(): number {
    return this.events.length;
  }

  /**
   * Remove all listeners
   */
  removeAllListeners(): void {
    this.listeners.clear();
    this.allListeners.clear();
  }
}
