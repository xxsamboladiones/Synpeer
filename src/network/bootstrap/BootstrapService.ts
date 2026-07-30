import type { PeerId } from '../NetworkTypes';
import { getNetworkService } from '../../services/network/NetworkService';

export interface BootstrapConfig {
  peers: string[];
  autoConnect?: boolean;
  retryInterval?: number;
  maxRetries?: number;
}

export interface BootstrapPeer {
  address: string;
  lastSeen?: number;
  successCount: number;
  failureCount: number;
}

/**
 * BootstrapService manages initial peer connections
 * Connects to known bootstrap peers to join the P2P network
 */
export class BootstrapService {
  private config: BootstrapConfig;
  private knownPeers: Map<string, BootstrapPeer>;
  private connectedPeers: Set<PeerId>;
  private retryTimer: ReturnType<typeof globalThis.setInterval> | null = null;

  constructor(config: BootstrapConfig) {
    this.config = {
      autoConnect: true,
      retryInterval: 30000, // 30 seconds
      maxRetries: 3,
      ...config,
    };
    this.knownPeers = new Map();
    this.connectedPeers = new Set();

    // Initialize known peers from config
    this.config.peers.forEach((address) => {
      this.knownPeers.set(address, {
        address,
        successCount: 0,
        failureCount: 0,
      });
    });
  }

  /**
   * Start bootstrap service
   */
  async start(): Promise<void> {
    if (this.config.autoConnect) {
      await this.connectToBootstrapPeers();
      this.startRetryLoop();
    }
  }

  /**
   * Stop bootstrap service
   */
  stop(): void {
    if (this.retryTimer) {
      // eslint-disable-next-line no-undef
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * Connect to all bootstrap peers
   */
  private async connectToBootstrapPeers(): Promise<void> {
    const promises = Array.from(this.knownPeers.keys()).map((address) =>
      this.connectToPeer(address),
    );
    await Promise.allSettled(promises);
  }

  /**
   * Connect to a single bootstrap peer using NetworkService
   */
  private async connectToPeer(address: string): Promise<boolean> {
    const peer = this.knownPeers.get(address);
    if (!peer) return false;

    try {
      // Use NetworkService for actual connection
      const networkService = getNetworkService();
      console.log(`[BootstrapService] Connecting to ${address}`);

      // Use PeerManager to connect to peer
      const peerManager = networkService.getPeerManager();
      if (peerManager && peerManager.isRunning()) {
        await peerManager.connectToPeer(address);

        peer.successCount++;
        peer.lastSeen = Date.now();
        this.knownPeers.set(address, peer);

        console.log(`[BootstrapService] Successfully connected to ${address}`);
        return true;
      } else {
        throw new Error('PeerManager not available or not running');
      }
    } catch (error) {
      console.error(`[BootstrapService] Failed to connect to ${address}:`, error);
      peer.failureCount++;
      this.knownPeers.set(address, peer);
      return false;
    }
  }

  /**
   * Start retry loop for failed connections
   */
  private startRetryLoop(): void {
    // eslint-disable-next-line no-undef
    this.retryTimer = setInterval(() => {
      this.retryFailedConnections();
    }, this.config.retryInterval!);
  }

  /**
   * Retry failed connections
   */
  private async retryFailedConnections(): Promise<void> {
    const failedPeers = Array.from(this.knownPeers.entries())
      .filter(([, peer]) => peer.failureCount < (this.config.maxRetries || 3))
      .map(([address]) => address);

    for (const address of failedPeers) {
      await this.connectToPeer(address);
    }
  }

  /**
   * Add new peer to known peers
   */
  addPeer(address: string): void {
    if (!this.knownPeers.has(address)) {
      this.knownPeers.set(address, {
        address,
        successCount: 0,
        failureCount: 0,
      });
    }
  }

  /**
   * Get all known peers
   */
  getKnownPeers(): BootstrapPeer[] {
    return Array.from(this.knownPeers.values());
  }

  /**
   * Get connected peers
   */
  getConnectedPeers(): PeerId[] {
    return Array.from(this.connectedPeers);
  }

  /**
   * Mark peer as connected
   */
  markConnected(peerId: PeerId): void {
    this.connectedPeers.add(peerId);
  }

  /**
   * Mark peer as disconnected
   */
  markDisconnected(peerId: PeerId): void {
    this.connectedPeers.delete(peerId);
  }
}
