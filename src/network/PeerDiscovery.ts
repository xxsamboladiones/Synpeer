import type { PeerManager } from './PeerManager';
import type { PeerId } from './NetworkTypes';
import type {
  AllDiscoveryEvents,
  DiscoveryEventListener,
  PeerDiscoveredEvent,
  PeerRemovedEvent,
} from './DiscoveryEvents';

/**
 * Peer discovery status
 */
export type DiscoveryStatus = 'idle' | 'discovering' | 'stopped' | 'error';

/**
 * Peer discovery configuration
 */
export interface DiscoveryConfig {
  /** Auto-discover on start */
  autoDiscover: boolean;
  /** Discovery interval in milliseconds */
  discoveryInterval: number;
  /** Peer timeout in milliseconds */
  peerTimeout: number;
  /** Enable bootstrap peers */
  enableBootstrap: boolean;
  /** Enable local discovery */
  enableLocalDiscovery: boolean;
}

/**
 * Default discovery configuration
 */
export const defaultDiscoveryConfig: DiscoveryConfig = {
  autoDiscover: true,
  discoveryInterval: 30000, // 30 seconds
  peerTimeout: 120000, // 2 minutes
  enableBootstrap: true,
  enableLocalDiscovery: true,
};

/**
 * PeerDiscovery manages peer discovery and tracking
 */
export class PeerDiscovery {
  private peerManager: PeerManager;
  private config: DiscoveryConfig;
  private status: DiscoveryStatus = 'idle';
  private listeners: Set<DiscoveryEventListener> = new Set();
  private discoveredPeers: Map<PeerId, number> = new Map(); // peerId -> lastSeen timestamp
  private discoveryInterval: number | null = null;

  constructor(peerManager: PeerManager, config: DiscoveryConfig = defaultDiscoveryConfig) {
    this.peerManager = peerManager;
    this.config = config;
  }

  /**
   * Start peer discovery
   */
  async start(): Promise<void> {
    if (this.status === 'discovering') {
      return;
    }

    this.status = 'discovering';
    this.emitEvent({ type: 'discovery:started', timestamp: Date.now() });

    // Discover bootstrap peers if enabled
    if (this.config.enableBootstrap) {
      await this.discoverBootstrapPeers();
    }

    // Start periodic discovery
    if (this.config.autoDiscover) {
      this.discoveryInterval = globalThis.setInterval(() => {
        this.performDiscovery();
      }, this.config.discoveryInterval) as unknown as number;
    }

    // Initial discovery
    await this.performDiscovery();
  }

  /**
   * Stop peer discovery
   */
  stop(): void {
    if (this.discoveryInterval) {
      globalThis.clearInterval(this.discoveryInterval);
      this.discoveryInterval = null;
    }

    this.status = 'stopped';
    this.emitEvent({ type: 'discovery:stopped', timestamp: Date.now() });
  }

  /**
   * Perform a single discovery cycle
   */
  private async performDiscovery(): Promise<void> {
    try {
      if (this.config.enableLocalDiscovery) {
        await this.discoverLocalPeers();
      }

      // Clean up timed out peers
      this.cleanupTimedOutPeers();
    } catch (error) {
      this.status = 'error';
      this.emitEvent({
        type: 'discovery:error',
        timestamp: Date.now(),
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Discover bootstrap peers
   */
  private async discoverBootstrapPeers(): Promise<void> {
    const bootstrapPeers = this.peerManager.getBootstrapPeers();
    for (const multiaddr of bootstrapPeers) {
      try {
        await this.peerManager.connectToPeer(multiaddr);
      } catch (error) {
        this.emitEvent({
          type: 'discovery:error',
          timestamp: Date.now(),
          error:
            error instanceof Error
              ? error.message
              : `Failed to connect bootstrap peer ${multiaddr}`,
        });
      }
    }

    await this.discoverLocalPeers();
  }

  /**
   * Discover local peers
   */
  private async discoverLocalPeers(): Promise<void> {
    // Get currently connected peers from PeerManager
    const connectedPeers = this.peerManager.getConnectedPeers();

    for (const peer of connectedPeers) {
      if (!this.discoveredPeers.has(peer.id)) {
        this.discoveredPeers.set(peer.id, Date.now());
        this.emitEvent({
          type: 'peer:discovered',
          timestamp: Date.now(),
          peerId: peer.id,
          source: 'local',
        } as PeerDiscoveredEvent);
      } else {
        // Update last seen
        this.discoveredPeers.set(peer.id, Date.now());
      }
    }
  }

  /**
   * Clean up peers that have timed out
   */
  private cleanupTimedOutPeers(): void {
    const now = Date.now();
    const timedOutPeers: PeerId[] = [];

    for (const [peerId, lastSeen] of this.discoveredPeers.entries()) {
      if (now - lastSeen > this.config.peerTimeout) {
        timedOutPeers.push(peerId);
      }
    }

    for (const peerId of timedOutPeers) {
      this.discoveredPeers.delete(peerId);
      this.emitEvent({
        type: 'peer:removed',
        timestamp: Date.now(),
        peerId,
        reason: 'timeout',
      } as PeerRemovedEvent);
    }
  }

  /**
   * Manually add a discovered peer
   */
  addDiscoveredPeer(peerId: PeerId, source: PeerDiscoveredEvent['source'] = 'manual'): void {
    if (!this.discoveredPeers.has(peerId)) {
      this.discoveredPeers.set(peerId, Date.now());
      this.emitEvent({
        type: 'peer:discovered',
        timestamp: Date.now(),
        peerId,
        source,
      } as PeerDiscoveredEvent);
    } else {
      this.discoveredPeers.set(peerId, Date.now());
    }
  }

  /**
   * Manually remove a peer
   */
  removePeer(peerId: PeerId, reason: PeerRemovedEvent['reason'] = 'manual'): void {
    if (this.discoveredPeers.has(peerId)) {
      this.discoveredPeers.delete(peerId);
      this.emitEvent({
        type: 'peer:removed',
        timestamp: Date.now(),
        peerId,
        reason,
      } as PeerRemovedEvent);
    }
  }

  /**
   * Get all discovered peers
   */
  getDiscoveredPeers(): PeerId[] {
    return Array.from(this.discoveredPeers.keys());
  }

  /**
   * Get discovery status
   */
  getStatus(): DiscoveryStatus {
    return this.status;
  }

  /**
   * Add event listener
   */
  addEventListener(listener: DiscoveryEventListener): void {
    this.listeners.add(listener);
  }

  /**
   * Remove event listener
   */
  removeEventListener(listener: DiscoveryEventListener): void {
    this.listeners.delete(listener);
  }

  /**
   * Emit event to all listeners
   */
  private emitEvent(event: AllDiscoveryEvents): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[PeerDiscovery] Error in event listener:', error);
      }
    }
  }

  /**
   * Clear all discovered peers
   */
  clearDiscoveredPeers(): void {
    this.discoveredPeers.clear();
  }
}
