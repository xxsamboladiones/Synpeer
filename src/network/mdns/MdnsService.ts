import type { PeerId } from '../NetworkTypes';

export interface MdnsConfig {
  serviceName: string;
  serviceType: string;
  port: number;
  enableBroadcast?: boolean;
}

export interface DiscoveredPeer {
  peerId: PeerId;
  hostname: string;
  address: string;
  port: number;
  lastSeen: number;
}

export interface MdnsPresence {
  peerId: PeerId;
  port: number;
  serviceName: string;
  serviceType: string;
}

export interface MdnsAdapter {
  start: (config: MdnsConfig, onPeerDiscovered: (peer: DiscoveredPeer) => void) => Promise<void>;
  stop: () => Promise<void> | void;
  broadcastPresence?: (presence: MdnsPresence) => Promise<void> | void;
}

/**
 * MdnsService handles local network peer discovery using mDNS
 * Devices on the same Wi-Fi network automatically discover each other
 */
export class MdnsService {
  private config: MdnsConfig;
  private discoveredPeers: Map<string, DiscoveredPeer>;
  private adapter: MdnsAdapter | null;
  private localPeerId: PeerId | null;
  private isRunning: boolean = false;
  private broadcastInterval: number | null = null;

  constructor(
    config: MdnsConfig,
    adapter: MdnsAdapter | null = null,
    localPeerId: PeerId | null = null,
  ) {
    this.config = {
      enableBroadcast: true,
      ...config,
    };
    this.discoveredPeers = new Map();
    this.adapter = adapter;
    this.localPeerId = localPeerId;
  }

  /**
   * Start mDNS service
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    console.log('[MdnsService] Starting mDNS service');

    this.isRunning = true;
    await this.adapter?.start(this.config, (peer) => this.handleDiscoveredPeer(peer));

    if (this.config.enableBroadcast) {
      this.startBroadcast();
    }
  }

  /**
   * Stop mDNS service
   */
  stop(): void {
    if (!this.isRunning) return;

    console.log('[MdnsService] Stopping mDNS service');

    if (this.broadcastInterval) {
      globalThis.clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }

    void this.adapter?.stop();

    this.isRunning = false;
  }

  /**
   * Start broadcasting presence
   */
  private startBroadcast(): void {
    this.broadcastInterval = globalThis.setInterval(() => {
      this.broadcastPresence();
    }, 60000) as unknown as number; // Broadcast every minute
    this.broadcastPresence();
  }

  /**
   * Broadcast presence to local network
   */
  private async broadcastPresence(): Promise<void> {
    if (!this.localPeerId || !this.adapter?.broadcastPresence) {
      return;
    }

    await this.adapter.broadcastPresence({
      peerId: this.localPeerId,
      port: this.config.port,
      serviceName: this.config.serviceName,
      serviceType: this.config.serviceType,
    });
  }

  /**
   * Handle discovered peer
   */
  private handleDiscoveredPeer(peer: DiscoveredPeer): void {
    if (peer.peerId === this.localPeerId) {
      return;
    }

    const key = `${peer.address}:${peer.port}`;

    console.log(`[MdnsService] Discovered peer: ${peer.hostname} at ${peer.address}:${peer.port}`);

    this.discoveredPeers.set(key, {
      ...peer,
      lastSeen: Date.now(),
    });
  }

  /**
   * Get all discovered peers
   */
  getDiscoveredPeers(): DiscoveredPeer[] {
    return Array.from(this.discoveredPeers.values());
  }

  /**
   * Remove peer
   */
  removePeer(address: string, port: number): void {
    const key = `${address}:${port}`;
    this.discoveredPeers.delete(key);
  }

  /**
   * Clean old peers (not seen in 5 minutes)
   */
  cleanOldPeers(): number {
    const threshold = Date.now() - 300000; // 5 minutes
    let removed = 0;

    for (const [key, peer] of this.discoveredPeers.entries()) {
      if (peer.lastSeen < threshold) {
        this.discoveredPeers.delete(key);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Check if service is running
   */
  isActive(): boolean {
    return this.isRunning;
  }
}
