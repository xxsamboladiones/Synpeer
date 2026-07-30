import type { PeerId } from './NetworkTypes';
import type { AllConnectionEvents, ConnectionEventListener } from './PeerConnection';
import type { AllDiscoveryEvents, DiscoveryEventListener } from './DiscoveryEvents';
import { createLogger } from '../observability/Logger';

export type PeerOperationalState =
  'offline' | 'connecting' | 'handshaking' | 'syncing' | 'online' | 'reconnecting' | 'degraded';

/**
 * Network event categories
 */
export type NetworkEventCategory = 'peer' | 'connection' | 'discovery' | 'sync' | 'error';

/**
 * Base network event
 */
export interface BaseNetworkEvent {
  category: NetworkEventCategory;
  timestamp: number;
}

/**
 * Peer connected event
 */
export interface PeerConnectedEvent extends BaseNetworkEvent {
  category: 'peer';
  type: 'peer:connected';
  peerId: PeerId;
}

/**
 * Peer disconnected event
 */
export interface PeerDisconnectedEvent extends BaseNetworkEvent {
  category: 'peer';
  type: 'peer:disconnected';
  peerId: PeerId;
  reason?: string;
}

export interface PeerStateChangedEvent extends BaseNetworkEvent {
  category: 'peer';
  type: 'peer:state-changed';
  peerId: PeerId;
  state: PeerOperationalState;
  previousState?: PeerOperationalState;
  failureCode?: string;
  reconnectAttempts: number;
  nextReconnectAt?: number;
}

/**
 * Sync started event
 */
export interface SyncStartedEvent extends BaseNetworkEvent {
  category: 'sync';
  type: 'sync:started';
  peerId: PeerId;
  syncType: 'identity' | 'data' | 'full';
}

/**
 * Sync finished event
 */
export interface SyncFinishedEvent extends BaseNetworkEvent {
  category: 'sync';
  type: 'sync:finished';
  peerId: PeerId;
  syncType: 'identity' | 'data' | 'full';
  success: boolean;
  itemsSynced?: number;
}

/**
 * Network error event
 */
export interface NetworkErrorEvent extends BaseNetworkEvent {
  category: 'error';
  type: 'network:error';
  error: string;
  context?: string;
  peerId?: PeerId;
}

/**
 * Union type for all network events
 */
export type NetworkEvent =
  | PeerConnectedEvent
  | PeerDisconnectedEvent
  | PeerStateChangedEvent
  | SyncStartedEvent
  | SyncFinishedEvent
  | NetworkErrorEvent;

/**
 * Network event listener
 */
export type NetworkEventListener = (event: NetworkEvent) => void;

/**
 * NetworkEvents is the central event bus for all network layer events
 */
export class NetworkEvents {
  private readonly logger = createLogger('network.events');
  private listeners: Map<NetworkEventCategory, Set<NetworkEventListener>> = new Map();
  private allListeners: Set<NetworkEventListener> = new Set();

  /**
   * Add event listener for a specific category
   */
  addEventListener(category: NetworkEventCategory, listener: NetworkEventListener): void {
    if (!this.listeners.has(category)) {
      this.listeners.set(category, new Set());
    }
    this.listeners.get(category)!.add(listener);
  }

  /**
   * Add event listener for all events
   */
  addAllEventListener(listener: NetworkEventListener): void {
    this.allListeners.add(listener);
  }

  /**
   * Remove event listener for a specific category
   */
  removeEventListener(category: NetworkEventCategory, listener: NetworkEventListener): void {
    this.listeners.get(category)?.delete(listener);
  }

  /**
   * Remove all event listener
   */
  removeAllEventListener(listener: NetworkEventListener): void {
    this.allListeners.delete(listener);
  }

  /**
   * Emit event to all listeners
   */
  emit(event: NetworkEvent): void {
    // Emit to category-specific listeners
    const categoryListeners = this.listeners.get(event.category);
    if (categoryListeners) {
      for (const listener of categoryListeners) {
        try {
          listener(event);
        } catch (error) {
          this.logger.error('category_listener_failed', error, {
            category: event.category,
            eventType: event.type,
          });
        }
      }
    }

    // Emit to all listeners
    for (const listener of this.allListeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error('all_listener_failed', error, {
          category: event.category,
          eventType: event.type,
        });
      }
    }
  }

  /**
   * Wrap connection event listener to convert to network event
   */
  wrapConnectionListener(listener: ConnectionEventListener): ConnectionEventListener {
    return (event) => {
      const networkEvent = this.connectionToNetworkEvent(event);
      if (networkEvent) {
        this.emit(networkEvent);
      }
      listener(event);
    };
  }

  /**
   * Wrap discovery event listener to convert to network event
   */
  wrapDiscoveryListener(listener: DiscoveryEventListener): DiscoveryEventListener {
    return (event) => {
      const networkEvent = this.discoveryToNetworkEvent(event);
      if (networkEvent) {
        this.emit(networkEvent);
      }
      listener(event);
    };
  }

  /**
   * Convert connection event to network event
   */
  private connectionToNetworkEvent(event: AllConnectionEvents): NetworkEvent | null {
    const timestamp = event.timestamp;

    switch (event.type) {
      case 'connection:established':
        return {
          category: 'peer',
          type: 'peer:connected',
          peerId: event.peerId,
          timestamp,
        } as PeerConnectedEvent;

      case 'connection:closed':
        return {
          category: 'peer',
          type: 'peer:disconnected',
          peerId: event.peerId,
          reason: event.reason,
          timestamp,
        } as PeerDisconnectedEvent;

      case 'connection:error':
        return {
          category: 'error',
          type: 'network:error',
          error: event.error,
          peerId: event.peerId,
          context: 'connection',
          timestamp,
        } as NetworkErrorEvent;

      case 'connection:reconnecting':
        // Reconnecting events are not converted to network events
        return null;

      default:
        return null;
    }
  }

  /**
   * Convert discovery event to network event
   */
  private discoveryToNetworkEvent(event: AllDiscoveryEvents): NetworkEvent | null {
    const timestamp = event.timestamp;

    switch (event.type) {
      case 'peer:discovered':
        return {
          category: 'peer',
          type: 'peer:connected',
          peerId: event.peerId,
          timestamp,
        } as PeerConnectedEvent;

      case 'peer:removed':
        return {
          category: 'peer',
          type: 'peer:disconnected',
          peerId: event.peerId,
          reason: event.reason,
          timestamp,
        } as PeerDisconnectedEvent;

      case 'discovery:error':
        return {
          category: 'error',
          type: 'network:error',
          error: event.error,
          context: 'discovery',
          timestamp,
        } as NetworkErrorEvent;

      case 'discovery:started':
      case 'discovery:stopped':
        // Discovery lifecycle events are not converted to network events
        return null;

      default:
        return null;
    }
  }

  /**
   * Clear all listeners
   */
  clearAllListeners(): void {
    this.listeners.clear();
    this.allListeners.clear();
  }

  /**
   * Get listener count for a category
   */
  getListenerCount(category?: NetworkEventCategory): number {
    if (category) {
      return this.listeners.get(category)?.size ?? 0;
    }
    let total = this.allListeners.size;
    for (const listeners of this.listeners.values()) {
      total += listeners.size;
    }
    return total;
  }
}
