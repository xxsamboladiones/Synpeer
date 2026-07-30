import { AppError } from '@/errors/AppError';
import type { PeerId } from '@/network/NetworkTypes';

import type { TrustedPeerRepository } from './TrustedPeerRepository';

export class TrustedPeerSyncService {
  constructor(
    private readonly repository: TrustedPeerRepository,
    private readonly requestRemoteSync: (peerId: PeerId) => Promise<number>,
  ) {}

  async syncPeer(peerId: PeerId): Promise<number> {
    const peer = this.repository.get(peerId);
    if (!peer || peer.trustStatus !== 'verified') {
      return 0;
    }
    try {
      return await this.requestRemoteSync(peerId);
    } catch (error) {
      throw new AppError({
        code: 'NETWORK_ERROR',
        message: error instanceof Error ? error.message : 'Remote peer sync failed',
        safeMessage: 'Nao foi possivel sincronizar com este peer.',
        severity: 'warning',
        retryable: true,
        context: {
          scope: 'sync.trusted-peer',
          peerId,
        },
        cause: error,
      });
    }
  }
}
