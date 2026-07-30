import { DefaultRuntimeHealthService } from '../RuntimeHealthService';
import { createRuntimeHealthSnapshot } from '../RuntimeHealth';

function createSnapshot() {
  return createRuntimeHealthSnapshot({
    state: 'idle',
    initialized: false,
    localPeerId: null,
    connectedPeers: [],
    discoveredPeers: [],
    networkRunning: false,
    canDialManualPeer: false,
    averageLatencyMs: null,
    sync: { pending: 0, sending: 0, confirmed: 0, failed: 0, lastSyncTimestamp: 0 },
    storage: { usedBytes: null, totalKeys: null },
    trustedPeers: [],
    transports: { messagesSent: 0, messagesReceived: 0, pendingMessages: 0 },
  });
}

describe('RuntimeHealthService', () => {
  it('returns runtime snapshots from the collector', async () => {
    const service = new DefaultRuntimeHealthService(() => createSnapshot());

    await expect(service.getSnapshot()).resolves.toMatchObject({
      state: 'idle',
      initialized: false,
    });
  });

  it('isolates failed component health contributors', async () => {
    const service = new DefaultRuntimeHealthService(
      () => createSnapshot(),
      [
        {
          getHealth: () => ({
            component: 'storage',
            status: 'healthy',
            checkedAt: 1,
            details: { privateKey: 'secret', records: 2 },
          }),
        },
        {
          getHealth: () => {
            throw new Error('boom');
          },
        },
      ],
    );

    const components = await service.getComponents();

    expect(components[0]).toMatchObject({
      component: 'storage',
      details: { privateKey: '[redacted]', records: 2 },
    });
    expect(components[1]).toMatchObject({
      component: 'unknown',
      status: 'unhealthy',
    });
  });
});
