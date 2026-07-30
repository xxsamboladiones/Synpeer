import type { PeerId } from '../../network/NetworkTypes';
import { ContributionEngine } from '../../contribution/ContributionEngine';
import { TrustEngine } from '../../contribution/TrustEngine';
import { getNetworkService, type NetworkService } from '../network/NetworkService';
import type { NetworkEvent } from '../../network/NetworkEvents';
import { createLogger } from '../../observability/Logger';

/**
 * ContributionNetworkIntegration connects network events to contribution tracking
 */
export class ContributionNetworkIntegration {
  private readonly logger = createLogger('ContributionNetworkIntegration');
  private contributionEngine: ContributionEngine;
  private trustEngine: TrustEngine;
  private networkService: NetworkService;
  private enabled: boolean = true;
  private startTime: number;

  constructor(
    contributionEngine: ContributionEngine,
    trustEngine: TrustEngine,
    networkService: NetworkService = getNetworkService(),
  ) {
    this.contributionEngine = contributionEngine;
    this.trustEngine = trustEngine;
    this.networkService = networkService;
    this.startTime = Date.now();
    this.setupNetworkListeners();
  }

  /**
   * Setup network event listeners
   */
  private setupNetworkListeners(): void {
    try {
      const networkEvents = this.networkService.getNetworkEvents();

      // Listen for all peer events
      networkEvents.addEventListener('peer', (event) => {
        this.handlePeerEvent(event);
      });

      // Listen for all discovery events
      networkEvents.addEventListener('discovery', (event) => {
        this.handleDiscoveryEvent(event);
      });

      this.logger.info('network_listeners_ready');
    } catch (error) {
      this.logger.error('network_listeners_setup_failed', error);
    }
  }

  /**
   * Handle peer events
   */
  private handlePeerEvent(event: NetworkEvent): void {
    if (!this.enabled) {
      return;
    }

    if (event.type === 'peer:connected') {
      const peerId = event.peerId;
      this.contributionEngine.emitEvent('PEER_CONNECTED', peerId, 1);
      this.trustEngine.recordPeerConnection(peerId);
    } else if (event.type === 'peer:disconnected') {
      const peerId = event.peerId;
      this.contributionEngine.emitEvent('PEER_DISCONNECTED', peerId, 0);
      this.trustEngine.recordPeerDisconnection(peerId);
    }
  }

  /**
   * Handle discovery events
   */
  private handleDiscoveryEvent(event: NetworkEvent): void {
    if (!this.enabled) {
      return;
    }

    this.logger.debug('discovery_event_received', { eventType: event.type });
  }

  /**
   * Record chunk served
   */
  recordChunkServed(peerId: PeerId, chunkSize: number): void {
    if (!this.enabled) {
      return;
    }

    this.contributionEngine.emitEvent('CHUNK_SERVED', peerId, chunkSize, { chunkSize });
    this.contributionEngine.emitEvent('BANDWIDTH_SHARED', peerId, chunkSize);
  }

  /**
   * Record chunk downloaded
   */
  recordChunkDownloaded(peerId: PeerId, chunkSize: number): void {
    if (!this.enabled) {
      return;
    }

    this.contributionEngine.emitEvent('CHUNK_DOWNLOADED', peerId, chunkSize, { chunkSize });
  }

  /**
   * Record post replicated
   */
  recordPostReplicated(peerId: PeerId): void {
    if (!this.enabled) {
      return;
    }

    this.contributionEngine.emitEvent('POST_REPLICATED', peerId, 1);
  }

  /**
   * Record media replicated
   */
  recordMediaReplicated(peerId: PeerId, mediaSize: number): void {
    if (!this.enabled) {
      return;
    }

    this.contributionEngine.emitEvent('MEDIA_REPLICATED', peerId, mediaSize, { mediaSize });
  }

  /**
   * Record upload finished
   */
  recordUploadFinished(peerId: PeerId, fileSize: number): void {
    if (!this.enabled) {
      return;
    }

    this.contributionEngine.emitEvent('UPLOAD_FINISHED', peerId, fileSize, { fileSize });
    this.contributionEngine.emitEvent('BANDWIDTH_SHARED', peerId, fileSize);
  }

  /**
   * Record download finished
   */
  recordDownloadFinished(peerId: PeerId, fileSize: number): void {
    if (!this.enabled) {
      return;
    }

    this.contributionEngine.emitEvent('DOWNLOAD_FINISHED', peerId, fileSize, { fileSize });
  }

  /**
   * Record storage shared
   */
  recordStorageShared(peerId: PeerId, storageSize: number): void {
    if (!this.enabled) {
      return;
    }

    this.contributionEngine.emitEvent('STORAGE_SHARED', peerId, storageSize, { storageSize });
  }

  /**
   * Record successful response
   */
  recordSuccessfulResponse(peerId: PeerId, responseTime: number): void {
    if (!this.enabled) {
      return;
    }

    this.trustEngine.recordSuccessfulResponse(peerId, responseTime);
    this.contributionEngine.emitEvent('DATA_VALIDATED', peerId, 1, { responseTime });
  }

  /**
   * Record failed response
   */
  recordFailedResponse(peerId: PeerId): void {
    if (!this.enabled) {
      return;
    }

    this.trustEngine.recordFailedResponse(peerId);
    this.contributionEngine.emitEvent('INVALID_DATA', peerId, 0);
  }

  /**
   * Record uptime
   */
  recordUptime(peerId: PeerId, seconds: number): void {
    if (!this.enabled) {
      return;
    }

    this.contributionEngine.emitEvent('UPTIME', peerId, seconds);
  }

  /**
   * Update peer availability
   */
  updatePeerAvailability(peerId: PeerId, availability: number): void {
    if (!this.enabled) {
      return;
    }

    this.trustEngine.updateAvailability(peerId, availability);
  }

  /**
   * Enable integration
   */
  enable(): void {
    this.enabled = true;
    this.logger.info('enabled');
  }

  /**
   * Disable integration
   */
  disable(): void {
    this.enabled = false;
    this.logger.info('disabled');
  }

  /**
   * Check if integration is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Get integration uptime
   */
  getUptime(): number {
    return Date.now() - this.startTime;
  }

  /**
   * Get contribution engine
   */
  getContributionEngine(): ContributionEngine {
    return this.contributionEngine;
  }

  /**
   * Get trust engine
   */
  getTrustEngine(): TrustEngine {
    return this.trustEngine;
  }

  /**
   * Reset integration
   */
  reset(): void {
    this.startTime = Date.now();
    this.logger.info('reset');
  }
}
