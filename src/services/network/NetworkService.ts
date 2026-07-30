import { CryptoService } from '../../crypto/CryptoService';
import { PeerIdentity, type PeerIdentityData } from '../../network/PeerIdentity';
import { PeerManager } from '../../network/PeerManager';
import { PeerDiscovery } from '../../network/PeerDiscovery';
import { PeerConnection } from '../../network/PeerConnection';
import { NetworkEvents } from '../../network/NetworkEvents';
import { PingProtocol } from '../../protocols/ping/PingProtocol';
import { localStorageService } from '../../services/storage/mmkvStorage';
import { defaultNetworkConfig } from '../../network/networkConfig';
import type { NetworkConfig } from '../../network/NetworkTypes';
import { createLogger } from '../../observability/Logger';
import type {
  SynpeerPrivateNetworkSnapshot,
  WebRtcAutoSignalingStatus,
} from '../../network/WebRtcAutoSignaling';

/**
 * Network service lifecycle state
 */
export type NetworkLifecycleState =
  'idle' | 'initializing' | 'running' | 'stopping' | 'stopped' | 'error';

/**
 * Network service configuration
 */
export interface NetworkServiceConfig {
  networkConfig?: NetworkConfig;
  autoStart?: boolean;
}

class NativeIdentityProtocolFacade {
  isAvailable(): boolean {
    return false;
  }

  clearAllIdentities(): void {
    return undefined;
  }
}

class NativeSyncProtocolFacade {
  isAvailable(): boolean {
    return false;
  }

  clearAllSyncResults(): void {
    return undefined;
  }
}

/**
 * NetworkService manages the complete network lifecycle
 * Integrates all network components: identity, discovery, connections, events, protocols
 */
export class NetworkService {
  private readonly logger = createLogger('NetworkService');
  private cryptoService: CryptoService;
  private peerIdentity: PeerIdentity;
  private peerManager: PeerManager;
  private peerDiscovery: PeerDiscovery;
  private peerConnection: PeerConnection;
  private networkEvents: NetworkEvents;
  private pingProtocol: PingProtocol;
  private identitySync: NativeIdentityProtocolFacade;
  private syncProtocol: NativeSyncProtocolFacade;

  private state: NetworkLifecycleState = 'idle';
  private config: NetworkServiceConfig;

  constructor(config: NetworkServiceConfig = {}) {
    this.config = config;

    // Initialize services
    this.cryptoService = new CryptoService(localStorageService);
    this.peerIdentity = new PeerIdentity(this.cryptoService, localStorageService);
    this.peerManager = new PeerManager(config.networkConfig ?? defaultNetworkConfig);
    this.peerDiscovery = new PeerDiscovery(this.peerManager);
    this.peerConnection = new PeerConnection(this.peerManager);
    this.networkEvents = new NetworkEvents();
    this.pingProtocol = new PingProtocol();
    this.identitySync = new NativeIdentityProtocolFacade();
    this.syncProtocol = new NativeSyncProtocolFacade();

    // Setup event integration
    this.setupEventIntegration();
  }

  /**
   * Setup integration between different event systems
   */
  private setupEventIntegration(): void {
    // Wrap discovery events
    this.peerDiscovery.addEventListener(() => {
      // Discovery events are already converted in NetworkEvents
    });

    // Wrap connection events
    this.peerConnection.addEventListener((event) => {
      switch (event.type) {
        case 'connection:established':
          this.networkEvents.emit({
            category: 'peer',
            type: 'peer:connected',
            peerId: event.peerId,
            timestamp: event.timestamp,
          });
          break;
        case 'connection:closed':
          this.networkEvents.emit({
            category: 'peer',
            type: 'peer:disconnected',
            peerId: event.peerId,
            reason: event.reason,
            timestamp: event.timestamp,
          });
          break;
        case 'connection:error':
          this.networkEvents.emit({
            category: 'error',
            type: 'network:error',
            peerId: event.peerId,
            error: event.error,
            context: 'connection',
            timestamp: event.timestamp,
          });
          break;
        case 'connection:reconnecting':
          break;
      }
    });
  }

  /**
   * Start the network service
   * Lifecycle: Load identity -> Start network -> Discover peers -> Connect -> Exchange identities
   */
  async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'initializing') {
      return;
    }

    this.state = 'initializing';

    try {
      // Step 1: Load or create identity
      const identity = await this.peerIdentity.getOrCreateIdentity();
      this.logger.info('identity_loaded', { peerId: identity.peerId });

      // Step 2: Start peer manager (libp2p)
      await this.peerManager.initialize();
      this.logger.info('peer_manager_started', {
        peerId: this.peerManager.getPeerId() ?? undefined,
      });

      // Step 3: Start peer discovery
      await this.peerDiscovery.start();
      this.logger.info('peer_discovery_started');

      // Step 4: Start periodic pinging for discovered peers
      const discoveredPeers = this.peerDiscovery.getDiscoveredPeers();
      if (discoveredPeers.length > 0) {
        this.pingProtocol.startPeriodicPing(discoveredPeers, async (peerId) => {
          // Send ping message (implementation depends on message transport)
          this.logger.debug('ping_send_requested', { peerId });
        });
      }

      // Step 5: Exchange identities with connected peers
      const connectedPeers = this.peerConnection.getConnectedPeers();
      for (const peerId of connectedPeers) {
        await this.exchangeIdentity(peerId);
      }

      this.state = 'running';
      this.logger.info('network_service_started');
    } catch (error) {
      this.state = 'error';
      this.logger.error('network_service_start_failed', error);
      throw error;
    }
  }

  /**
   * Stop the network service
   */
  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'stopping') {
      return;
    }

    this.state = 'stopping';

    try {
      // Stop protocols
      this.pingProtocol.stopPeriodicPing();
      this.pingProtocol.clearAllPingResults();
      this.identitySync.clearAllIdentities();
      this.syncProtocol.clearAllSyncResults();

      // Stop discovery
      this.peerDiscovery.stop();
      this.peerDiscovery.clearDiscoveredPeers();

      // Stop connections
      await this.peerConnection.disconnectAll();
      await this.peerConnection.cleanup();

      // Stop peer manager
      await this.peerManager.stop();

      this.state = 'stopped';
      this.logger.info('network_service_stopped');
    } catch (error) {
      this.state = 'error';
      this.logger.error('network_service_stop_failed', error);
      throw error;
    }
  }

  /**
   * Exchange identity with a peer
   */
  private async exchangeIdentity(peerId: string): Promise<void> {
    void this.peerIdentity.getOrCreateIdentity();
    this.logger.warn('native_identity_handshake_unavailable', { peerId });
  }

  /**
   * Get current network state
   */
  getState(): NetworkLifecycleState {
    return this.state;
  }

  /**
   * Get local peer identity
   */
  async getLocalIdentity(): Promise<PeerIdentityData | null> {
    return this.peerIdentity.getIdentity();
  }

  /**
   * Get connected peers
   */
  getConnectedPeers(): string[] {
    return this.peerConnection.getConnectedPeers();
  }

  getListenAddresses(): string[] {
    return this.peerManager.getListenAddresses();
  }

  canConnectToPeerAddress(): boolean {
    return this.isRunning();
  }

  canAutoReconnectToPeerAddress(): boolean {
    return this.isRunning();
  }

  canAutoConnectToPeer(): boolean {
    return false;
  }

  getAutoSignalingStatus(): WebRtcAutoSignalingStatus | null {
    return null;
  }

  restartAutoSignaling(): void {
    return undefined;
  }

  async createPrivateNetwork(_name?: string, _signalingUrl?: string): Promise<string> {
    void _name;
    void _signalingUrl;
    throw new Error('Synpeer private network controller is not available in this runtime.');
  }

  async joinPrivateNetwork(_inviteCode: string): Promise<SynpeerPrivateNetworkSnapshot | null> {
    void _inviteCode;
    throw new Error('Synpeer private network controller is not available in this runtime.');
  }

  async approvePrivateNetworkPeer(_peerId: string): Promise<void> {
    void _peerId;
    throw new Error('Synpeer private network controller is not available in this runtime.');
  }

  getPrivateNetworkSnapshot(): SynpeerPrivateNetworkSnapshot | null {
    return null;
  }

  setSignalingServerUrl(_url: string | null): void {
    void _url;
  }

  async connectToPeerAddress(multiaddr: string): Promise<void> {
    await this.peerManager.connectToPeer(multiaddr);
    const connected = this.peerManager.getConnectedPeers();
    const peer =
      connected.find((info) => info.addresses.includes(multiaddr)) ??
      connected[connected.length - 1];
    if (peer) {
      this.peerDiscovery.addDiscoveredPeer(peer.id, 'manual');
      await this.peerConnection.connectToPeer(peer.id);
    }
  }

  async disconnectPeer(peerId: string): Promise<void> {
    await this.peerConnection.disconnectFromPeer(peerId, 'removed-locally');
  }

  async resetPeerConnections(_reason = 'manual-reset'): Promise<void> {
    void _reason;
    await this.peerConnection.disconnectAll();
  }

  /**
   * Get discovered peers
   */
  getDiscoveredPeers(): string[] {
    return this.peerDiscovery.getDiscoveredPeers();
  }

  /**
   * Get network events instance
   */
  getNetworkEvents(): NetworkEvents {
    return this.networkEvents;
  }

  /**
   * Get peer manager instance
   */
  getPeerManager(): PeerManager {
    return this.peerManager;
  }

  /**
   * Get peer discovery instance
   */
  getPeerDiscovery(): PeerDiscovery {
    return this.peerDiscovery;
  }

  /**
   * Get peer connection instance
   */
  getPeerConnection(): PeerConnection {
    return this.peerConnection;
  }

  /**
   * Get ping protocol instance
   */
  getPingProtocol(): PingProtocol {
    return this.pingProtocol;
  }

  /**
   * Get identity sync instance
   */
  getIdentitySync(): NativeIdentityProtocolFacade {
    return this.identitySync;
  }

  /**
   * Get sync protocol instance
   */
  getSyncProtocol(): NativeSyncProtocolFacade {
    return this.syncProtocol;
  }

  /**
   * Check if network is running
   */
  isRunning(): boolean {
    return this.state === 'running';
  }

  /**
   * Restart the network service
   */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /**
   * Cleanup all resources
   */
  async cleanup(): Promise<void> {
    await this.stop();
    this.networkEvents.clearAllListeners();
  }
}

/**
 * Singleton instance of NetworkService
 */
let networkServiceInstance: NetworkService | null = null;

/**
 * Get or create the NetworkService singleton
 */
export function getNetworkService(config?: NetworkServiceConfig): NetworkService {
  if (!networkServiceInstance) {
    networkServiceInstance = new NetworkService(config);
  }
  return networkServiceInstance;
}

/**
 * Reset the NetworkService singleton (for testing)
 */
export function resetNetworkService(): void {
  if (networkServiceInstance) {
    networkServiceInstance.cleanup();
    networkServiceInstance = null;
  }
}
