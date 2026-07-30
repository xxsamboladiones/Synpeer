import type { RuntimeState } from './ApplicationRuntime';
import type { StorageHealthSnapshot } from './StorageHealth';

export interface RuntimeHealthSnapshot {
  state: RuntimeState;
  initialized: boolean;
  localPeerId: string | null;
  network: {
    running: boolean;
    connectedPeers: number;
    discoveredPeers: number;
    knownPeers: number;
    canDialManualPeer: boolean;
    connectionQuality: 'offline' | 'connected' | 'good';
    averageLatencyMs: number | null;
  };
  sync: {
    pending: number;
    sending: number;
    confirmed: number;
    failed: number;
    lastSyncTimestamp: number;
  };
  storage: {
    usedBytes: number | null;
    totalKeys: number | null;
    details?: StorageHealthSnapshot | null;
  };
  peers: {
    trusted: number;
    verified: number;
    blocked: number;
  };
  transports: {
    messagesSent: number;
    messagesReceived: number;
    pendingMessages: number;
  };
}

export interface RuntimeHealthInput {
  state: RuntimeHealthSnapshot['state'];
  initialized: boolean;
  localPeerId: string | null;
  connectedPeers: string[];
  discoveredPeers: string[];
  networkRunning: boolean;
  canDialManualPeer: boolean;
  averageLatencyMs: number | null;
  sync: RuntimeHealthSnapshot['sync'];
  storage: RuntimeHealthSnapshot['storage'];
  trustedPeers: Array<{ trustStatus: 'unknown' | 'verified' | 'blocked' }>;
  transports: RuntimeHealthSnapshot['transports'];
}

export function createRuntimeHealthSnapshot(input: RuntimeHealthInput): RuntimeHealthSnapshot {
  const knownPeers = new Set([...input.connectedPeers, ...input.discoveredPeers]);

  return {
    state: input.state,
    initialized: input.initialized,
    localPeerId: input.localPeerId,
    network: {
      running: input.networkRunning,
      connectedPeers: input.connectedPeers.length,
      discoveredPeers: input.discoveredPeers.length,
      knownPeers: knownPeers.size,
      canDialManualPeer: input.canDialManualPeer,
      connectionQuality:
        input.connectedPeers.length > 0
          ? input.averageLatencyMs !== null && input.averageLatencyMs < 250
            ? 'good'
            : 'connected'
          : 'offline',
      averageLatencyMs: input.averageLatencyMs,
    },
    sync: input.sync,
    storage: input.storage,
    peers: {
      trusted: input.trustedPeers.length,
      verified: input.trustedPeers.filter((peer) => peer.trustStatus === 'verified').length,
      blocked: input.trustedPeers.filter((peer) => peer.trustStatus === 'blocked').length,
    },
    transports: input.transports,
  };
}
