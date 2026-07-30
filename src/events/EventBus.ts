import { createLogger } from '../observability/Logger';

/**
 * Event types for the application
 */
export type AppEventType =
  | 'PeerConnected'
  | 'PeerDisconnected'
  | 'PostCreated'
  | 'PostReceived'
  | 'MediaReceived'
  | 'WalletUpdated'
  | 'ConsensusReached'
  | 'ReputationChanged'
  | 'NetworkError'
  | 'SyncCompleted'
  | 'RewardReceived';

/**
 * Base event interface
 */
export interface AppEvent {
  type: AppEventType;
  timestamp: number;
  data?: unknown;
}

/**
 * Event listener function type
 */
export type EventListener = (event: AppEvent) => void;

/**
 * EventBus manages all application events
 * Central event system for decoupling components
 */
export class EventBus {
  private static instance: EventBus;
  private readonly logger = createLogger('EventBus');
  private listeners: Map<AppEventType, Set<EventListener>>;
  private eventHistory: AppEvent[];
  private maxHistorySize: number = 100;

  private constructor() {
    this.listeners = new Map();
    this.eventHistory = [];
  }

  static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  /**
   * Subscribe to an event type
   */
  on(eventType: AppEventType, listener: EventListener): void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(listener);
    this.logger.debug('listener_registered', { eventType });
  }

  /**
   * Unsubscribe from an event type
   */
  off(eventType: AppEventType, listener: EventListener): void {
    const listeners = this.listeners.get(eventType);
    if (listeners) {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(eventType);
      }
      this.logger.debug('listener_unregistered', { eventType });
    }
  }

  /**
   * Emit an event
   */
  emit(eventType: AppEventType, data?: unknown): void {
    const event: AppEvent = {
      type: eventType,
      timestamp: Date.now(),
      data,
    };

    // Add to history
    this.eventHistory.push(event);
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift();
    }

    // Notify listeners
    const listeners = this.listeners.get(eventType);
    if (listeners) {
      this.logger.debug('event_emitted', { eventType, listenerCount: listeners.size });
      listeners.forEach((listener) => {
        try {
          listener(event);
        } catch (error) {
          this.logger.error('listener_failed', error, { eventType });
        }
      });
    }
  }

  /**
   * Get event history
   */
  getHistory(eventType?: AppEventType): AppEvent[] {
    if (eventType) {
      return this.eventHistory.filter((e) => e.type === eventType);
    }
    return [...this.eventHistory];
  }

  /**
   * Clear event history
   */
  clearHistory(): void {
    this.eventHistory = [];
    this.logger.debug('history_cleared');
  }

  /**
   * Clear all listeners
   */
  clearListeners(): void {
    this.listeners.clear();
    this.logger.debug('listeners_cleared');
  }

  /**
   * Get listener count for an event type
   */
  getListenerCount(eventType: AppEventType): number {
    return this.listeners.get(eventType)?.size ?? 0;
  }

  /**
   * Get all event types with listeners
   */
  getActiveEventTypes(): AppEventType[] {
    return Array.from(this.listeners.keys());
  }
}

export const eventBus = EventBus.getInstance();

/**
 * Convenience functions for common events
 */
export const emitPeerConnected = (peerId: string): void => {
  eventBus.emit('PeerConnected', { peerId });
};

export const emitPeerDisconnected = (peerId: string): void => {
  eventBus.emit('PeerDisconnected', { peerId });
};

export const emitPostCreated = (postId: string, author: string): void => {
  eventBus.emit('PostCreated', { postId, author });
};

export const emitPostReceived = (postId: string, author: string): void => {
  eventBus.emit('PostReceived', { postId, author });
};

export const emitMediaReceived = (mediaId: string, type: string): void => {
  eventBus.emit('MediaReceived', { mediaId, type });
};

export const emitWalletUpdated = (address: string, balance: number): void => {
  eventBus.emit('WalletUpdated', { address, balance });
};

export const emitConsensusReached = (consensusId: string, result: string): void => {
  eventBus.emit('ConsensusReached', { consensusId, result });
};

export const emitReputationChanged = (peerId: string, score: number): void => {
  eventBus.emit('ReputationChanged', { peerId, score });
};

export const emitNetworkError = (error: string, details?: unknown): void => {
  eventBus.emit('NetworkError', { error, details });
};

export const emitSyncCompleted = (syncedCount: number): void => {
  eventBus.emit('SyncCompleted', { syncedCount });
};

export const emitRewardReceived = (amount: number, category: string): void => {
  eventBus.emit('RewardReceived', { amount, category });
};
