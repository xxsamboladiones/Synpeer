import { createRuntimeHealthSnapshot } from '../RuntimeHealth';

describe('RuntimeHealth', () => {
  it('derives peer counts, trust counts and connection quality from runtime inputs', () => {
    const snapshot = createRuntimeHealthSnapshot({
      state: 'ready',
      initialized: true,
      localPeerId: 'peer-local',
      connectedPeers: ['peer-a'],
      discoveredPeers: ['peer-a', 'peer-b'],
      networkRunning: true,
      canDialManualPeer: true,
      averageLatencyMs: 120,
      sync: {
        pending: 1,
        sending: 2,
        confirmed: 3,
        failed: 4,
        lastSyncTimestamp: 1000,
      },
      storage: {
        usedBytes: 123,
        totalKeys: 2,
      },
      trustedPeers: [
        { trustStatus: 'verified' },
        { trustStatus: 'blocked' },
        { trustStatus: 'unknown' },
      ],
      transports: {
        messagesSent: 10,
        messagesReceived: 5,
        pendingMessages: 1,
      },
    });

    expect(snapshot.network.knownPeers).toBe(2);
    expect(snapshot.network.connectionQuality).toBe('good');
    expect(snapshot.peers).toEqual({ trusted: 3, verified: 1, blocked: 1 });
    expect(snapshot.sync.pending).toBe(1);
  });

  it('reports offline when there are no connected peers', () => {
    const snapshot = createRuntimeHealthSnapshot({
      state: 'idle',
      initialized: false,
      localPeerId: null,
      connectedPeers: [],
      discoveredPeers: ['peer-b'],
      networkRunning: false,
      canDialManualPeer: false,
      averageLatencyMs: null,
      sync: { pending: 0, sending: 0, confirmed: 0, failed: 0, lastSyncTimestamp: 0 },
      storage: { usedBytes: null, totalKeys: null },
      trustedPeers: [],
      transports: { messagesSent: 0, messagesReceived: 0, pendingMessages: 0 },
    });

    expect(snapshot.network.running).toBe(false);
    expect(snapshot.network.connectionQuality).toBe('offline');
    expect(snapshot.network.knownPeers).toBe(1);
  });
});
