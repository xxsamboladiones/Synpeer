import type { NetworkService } from '@/services/network/NetworkService';
import { createLogger } from '@/observability/Logger';
import type { PeerId } from '@/network/NetworkTypes';

import type { TrustedPeerRepository } from './TrustedPeerRepository';
import type { TrustedPeerSyncService } from './TrustedPeerSyncService';
import { getAutoDialPeerAddresses } from './PeerAddress';

type ReconnectNetworkService = NetworkService & {
  canAutoConnectToPeer?: () => boolean;
  connectToPeer?: (peerId: PeerId) => Promise<unknown>;
  getConnectedPeers?: () => string[];
  requestPeerReconnect?: (peerId: PeerId, reason?: string, immediate?: boolean) => boolean;
};

export class PeerReconnectService {
  private readonly logger = createLogger('PeerReconnectService');
  private reconnectOperation: Promise<void> | null = null;

  constructor(
    private readonly repository: TrustedPeerRepository,
    private readonly getNetworkService: () => NetworkService,
    private readonly syncService: TrustedPeerSyncService,
  ) {}

  async reconnectTrustedPeers(): Promise<void> {
    if (this.reconnectOperation) {
      await this.reconnectOperation;
      return;
    }
    this.reconnectOperation = this.performReconnectTrustedPeers().finally(() => {
      this.reconnectOperation = null;
    });
    await this.reconnectOperation;
  }

  private async performReconnectTrustedPeers(): Promise<void> {
    const networkService = this.getNetworkService();
    if (!this.canAutoReconnect(networkService)) {
      this.logger.debug('auto_reconnect_unavailable');
      return;
    }

    const peers = this.repository.list().filter((peer) => peer.trustStatus !== 'blocked');
    const connectedPeers = new Set(
      (networkService as ReconnectNetworkService).getConnectedPeers?.() ?? [],
    );
    const coordinatedReconnect = (networkService as ReconnectNetworkService).requestPeerReconnect;

    if (coordinatedReconnect) {
      for (const peer of peers) {
        if (peer.trustStatus !== 'verified' || connectedPeers.has(peer.peerId)) {
          continue;
        }
        coordinatedReconnect.call(networkService, peer.peerId, 'startup-restore', true);
      }
      return;
    }

    for (const peer of peers) {
      if (connectedPeers.has(peer.peerId) || peer.sessionState === 'connecting') {
        continue;
      }
      for (const address of getAutoDialPeerAddresses(peer.addresses)) {
        try {
          await networkService.connectToPeerAddress(address);
          this.repository.recordConnection(peer.peerId);
          if (peer.trustStatus === 'verified') {
            await this.syncService.syncPeer(peer.peerId);
          }
          break;
        } catch (error) {
          this.logger.warn('peer_reconnect_failed', {
            peerId: peer.peerId,
            message: error instanceof Error ? error.message : 'Unknown reconnect failure',
          });
        }
      }

      if (
        getAutoDialPeerAddresses(peer.addresses).length === 0 &&
        peer.trustStatus === 'verified' &&
        this.canAutoConnectToPeer(networkService)
      ) {
        try {
          await (networkService as ReconnectNetworkService).connectToPeer?.(peer.peerId);
          this.repository.updateSessionState(peer.peerId, 'connecting');
        } catch (error) {
          this.logger.warn('peer_signaling_reconnect_failed', {
            peerId: peer.peerId,
            message: error instanceof Error ? error.message : 'Unknown signaling reconnect failure',
          });
        }
      }
    }
  }

  private canAutoReconnect(networkService: NetworkService): boolean {
    const candidate = networkService as ReconnectNetworkService;
    return (
      candidate.canAutoConnectToPeer?.() ??
      candidate.canAutoReconnectToPeerAddress?.() ??
      networkService.canConnectToPeerAddress()
    );
  }

  private canAutoConnectToPeer(networkService: NetworkService): boolean {
    const candidate = networkService as ReconnectNetworkService;
    return Boolean(candidate.canAutoConnectToPeer?.() && candidate.connectToPeer);
  }
}
