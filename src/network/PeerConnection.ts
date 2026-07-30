import type { PeerManager } from './PeerManager';
import type { ConnectionState, PeerId } from './NetworkTypes';

/**
 * Connection state with metadata
 */
export interface ConnectionInfo {
  peerId: PeerId;
  state: ConnectionState;
  connectedAt: number;
  lastActivity: number;
  reconnectCount: number;
}

/**
 * Connection events
 */
export type ConnectionEventType =
  'connection:established' | 'connection:closed' | 'connection:error' | 'connection:reconnecting';

/**
 * Base connection event
 */
export interface ConnectionEvent {
  type: ConnectionEventType;
  peerId: PeerId;
  timestamp: number;
}

/**
 * Connection established event
 */
export interface ConnectionEstablishedEvent extends ConnectionEvent {
  type: 'connection:established';
}

/**
 * Connection closed event
 */
export interface ConnectionClosedEvent extends ConnectionEvent {
  type: 'connection:closed';
  reason?: string;
}

/**
 * Connection error event
 */
export interface ConnectionErrorEvent extends ConnectionEvent {
  type: 'connection:error';
  error: string;
}

/**
 * Connection reconnecting event
 */
export interface ConnectionReconnectingEvent extends ConnectionEvent {
  type: 'connection:reconnecting';
  attempt: number;
}

/**
 * Union type for all connection events
 */
export type AllConnectionEvents =
  | ConnectionEstablishedEvent
  | ConnectionClosedEvent
  | ConnectionErrorEvent
  | ConnectionReconnectingEvent;

/**
 * Connection event listener
 */
export type ConnectionEventListener = (event: AllConnectionEvents) => void;

/**
 * Connection configuration
 */
export interface ConnectionConfig {
  /** Auto-reconnect on disconnect */
  autoReconnect: boolean;
  /** Maximum reconnect attempts */
  maxReconnectAttempts: number;
  /** Reconnect delay in milliseconds */
  reconnectDelay: number;
  /** Connection timeout in milliseconds */
  connectionTimeout: number;
}

/**
 * Default connection configuration
 */
export const defaultConnectionConfig: ConnectionConfig = {
  autoReconnect: true,
  maxReconnectAttempts: 5,
  reconnectDelay: 5000, // 5 seconds
  connectionTimeout: 30000, // 30 seconds
};

/**
 * PeerConnection manages secure peer connections
 */
export class PeerConnection {
  private peerManager: PeerManager;
  private config: ConnectionConfig;
  private connections: Map<PeerId, ConnectionInfo> = new Map();
  private listeners: Set<ConnectionEventListener> = new Set();
  private reconnectTimers: Map<PeerId, ReturnType<typeof globalThis.setTimeout>> = new Map();

  constructor(peerManager: PeerManager, config: ConnectionConfig = defaultConnectionConfig) {
    this.peerManager = peerManager;
    this.config = config;
  }

  /**
   * Connect to a peer
   */
  async connectToPeer(peerId: PeerId, multiaddr?: string): Promise<void> {
    const existingConnection = this.connections.get(peerId);

    if (existingConnection?.state === 'connected') {
      return; // Already connected
    }

    if (existingConnection?.state === 'connecting') {
      return; // Already connecting
    }

    // Update connection state
    this.connections.set(peerId, {
      peerId,
      state: 'connecting',
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      reconnectCount: existingConnection?.reconnectCount ?? 0,
    });

    try {
      if (multiaddr) {
        await this.peerManager.connectToPeer(multiaddr);
      }

      // Update to connected state
      this.connections.set(peerId, {
        peerId,
        state: 'connected',
        connectedAt: Date.now(),
        lastActivity: Date.now(),
        reconnectCount: existingConnection?.reconnectCount ?? 0,
      });

      this.emitEvent({
        type: 'connection:established',
        peerId,
        timestamp: Date.now(),
      } as ConnectionEstablishedEvent);

      // Clear reconnect timer if exists
      const timer = this.reconnectTimers.get(peerId);
      if (timer) {
        clearTimeout(timer);
        this.reconnectTimers.delete(peerId);
      }
    } catch (error) {
      this.connections.set(peerId, {
        peerId,
        state: 'error',
        connectedAt: Date.now(),
        lastActivity: Date.now(),
        reconnectCount: existingConnection?.reconnectCount ?? 0,
      });

      this.emitEvent({
        type: 'connection:error',
        peerId,
        timestamp: Date.now(),
        error: error instanceof Error ? error.message : 'Unknown error',
      } as ConnectionErrorEvent);

      // Attempt reconnect if enabled
      if (this.config.autoReconnect) {
        this.scheduleReconnect(peerId, multiaddr);
      }

      throw error;
    }
  }

  /**
   * Disconnect from a peer
   */
  async disconnectFromPeer(peerId: PeerId, reason?: string): Promise<void> {
    const connection = this.connections.get(peerId);

    if (!connection) {
      return; // No connection to disconnect
    }

    // Clear reconnect timer
    const timer = this.reconnectTimers.get(peerId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(peerId);
    }

    // Update connection state
    this.connections.set(peerId, {
      peerId,
      state: 'disconnected',
      connectedAt: connection.connectedAt,
      lastActivity: Date.now(),
      reconnectCount: connection.reconnectCount,
    });

    this.emitEvent({
      type: 'connection:closed',
      peerId,
      timestamp: Date.now(),
      reason,
    } as ConnectionClosedEvent);

    // Remove from connections map
    this.connections.delete(peerId);
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(peerId: PeerId, multiaddr?: string): void {
    const connection = this.connections.get(peerId);

    if (!connection) {
      return;
    }

    const reconnectCount = connection.reconnectCount + 1;

    if (reconnectCount > this.config.maxReconnectAttempts) {
      this.emitEvent({
        type: 'connection:closed',
        peerId,
        timestamp: Date.now(),
        reason: 'Max reconnect attempts reached',
      } as ConnectionClosedEvent);

      this.connections.delete(peerId);
      return;
    }

    this.emitEvent({
      type: 'connection:reconnecting',
      peerId,
      timestamp: Date.now(),
      attempt: reconnectCount,
    } as ConnectionReconnectingEvent);

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(peerId);
      this.connectToPeer(peerId, multiaddr).catch(() => {
        // Error is handled in connectToPeer
      });
    }, this.config.reconnectDelay);

    this.reconnectTimers.set(peerId, timer);
  }

  /**
   * Get connection info for a peer
   */
  getConnectionInfo(peerId: PeerId): ConnectionInfo | null {
    return this.connections.get(peerId) ?? null;
  }

  /**
   * Get all connections
   */
  getAllConnections(): ConnectionInfo[] {
    return Array.from(this.connections.values());
  }

  /**
   * Get connected peers
   */
  getConnectedPeers(): PeerId[] {
    return Array.from(this.connections.values())
      .filter((conn) => conn.state === 'connected')
      .map((conn) => conn.peerId);
  }

  /**
   * Update last activity for a peer
   */
  updateActivity(peerId: PeerId): void {
    const connection = this.connections.get(peerId);
    if (connection) {
      this.connections.set(peerId, {
        ...connection,
        lastActivity: Date.now(),
      });
    }
  }

  /**
   * Add event listener
   */
  addEventListener(listener: ConnectionEventListener): void {
    this.listeners.add(listener);
  }

  /**
   * Remove event listener
   */
  removeEventListener(listener: ConnectionEventListener): void {
    this.listeners.delete(listener);
  }

  /**
   * Emit event to all listeners
   */
  private emitEvent(event: AllConnectionEvents): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[PeerConnection] Error in event listener:', error);
      }
    }
  }

  /**
   * Disconnect all peers
   */
  async disconnectAll(): Promise<void> {
    const peerIds = Array.from(this.connections.keys());

    for (const peerId of peerIds) {
      await this.disconnectFromPeer(peerId, 'Shutting down');
    }
  }

  /**
   * Clear all reconnect timers
   */
  private clearReconnectTimers(): void {
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
  }

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    this.clearReconnectTimers();
    await this.disconnectAll();
    this.listeners.clear();
  }
}
