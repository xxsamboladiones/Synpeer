import type { PeerId } from '@/network/NetworkTypes';

import { PeerSessionCoordinator } from '../PeerSessionCoordinator';

const peerA = 'peer-a' as PeerId;
const peerB = 'peer-b' as PeerId;
const coordinators: PeerSessionCoordinator[] = [];

function createCoordinator(
  ...args: ConstructorParameters<typeof PeerSessionCoordinator>
): PeerSessionCoordinator {
  const coordinator = new PeerSessionCoordinator(...args);
  coordinators.push(coordinator);
  return coordinator;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (!resolvePromise) {
        throw new Error('Deferred promise is not initialized');
      }
      resolvePromise(value);
    },
  };
}

describe('PeerSessionCoordinator', () => {
  afterEach(() => {
    for (const coordinator of coordinators.splice(0)) {
      coordinator.stop();
    }
    jest.useRealTimers();
  });

  it('shares concurrent connection attempts for the same peer', async () => {
    const deferred = createDeferred<{ mode: 'auto-signaling' }>();
    const operation = jest.fn(() => deferred.promise);
    const coordinator = createCoordinator(peerA);

    const first = coordinator.coordinateConnect(peerB, operation);
    const second = coordinator.coordinateConnect(peerB, operation);

    expect(second).toBe(first);
    expect(operation).toHaveBeenCalledTimes(1);
    deferred.resolve({ mode: 'auto-signaling' });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { mode: 'auto-signaling' },
      { mode: 'auto-signaling' },
    ]);
    expect(coordinator.coordinateConnect(peerB, operation)).toBe(first);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('keeps the lower peer id outbound offer during glare', () => {
    const coordinator = createCoordinator(peerA, { now: () => 2000 });
    void coordinator.coordinateConnect(peerB, async () => ({ mode: 'auto-signaling' }));
    expect(coordinator.registerOutbound(peerB, 'offer-a')).toBe(true);

    const decision = coordinator.considerIncomingOffer(peerB, 'offer-b', 2100);

    expect(decision).toEqual({
      accepted: false,
      reason: 'glare-local-wins',
    });
    expect(coordinator.getSnapshot(peerB)).toMatchObject({
      direction: 'outbound',
      negotiationId: 'offer-a',
    });
  });

  it('replaces the higher peer id outbound offer during glare', () => {
    const coordinator = createCoordinator(peerB, { now: () => 2000 });
    void coordinator.coordinateConnect(peerA, async () => ({ mode: 'auto-signaling' }));
    expect(coordinator.registerOutbound(peerA, 'offer-b')).toBe(true);

    const decision = coordinator.considerIncomingOffer(peerA, 'offer-a', 2100);

    expect(decision).toEqual({
      accepted: true,
      replacedNegotiationId: 'offer-b',
    });
    expect(coordinator.getSnapshot(peerA)).toMatchObject({
      direction: 'inbound',
      negotiationId: 'offer-a',
    });
  });

  it('replaces a stalled lower-id outbound offer with a clearly newer offer', () => {
    let now = 2_000;
    const coordinator = createCoordinator(peerA, { now: () => now });
    void coordinator.coordinateConnect(peerB, async () => ({ mode: 'auto-signaling' }));
    expect(coordinator.registerOutbound(peerB, 'offer-stalled', 2_000)).toBe(true);

    now = 10_000;
    const decision = coordinator.considerIncomingOffer(peerB, 'offer-reconnect', 10_000);

    expect(decision).toEqual({
      accepted: true,
      replacedNegotiationId: 'offer-stalled',
    });
    expect(coordinator.getSnapshot(peerB)).toMatchObject({
      direction: 'inbound',
      negotiationId: 'offer-reconnect',
    });
  });

  it('rejects stale inbound offers and answers from superseded negotiations', () => {
    const coordinator = createCoordinator(peerB, { now: () => 3000 });
    expect(coordinator.considerIncomingOffer(peerA, 'new-offer', 2500)).toEqual({
      accepted: true,
      replacedNegotiationId: undefined,
    });

    expect(coordinator.considerIncomingOffer(peerA, 'old-offer', 2000)).toEqual({
      accepted: false,
      reason: 'stale-offer',
    });
    expect(coordinator.canApplyAnswer(peerA, 'old-offer')).toBe(false);
  });

  it('only applies answers for the active outbound negotiation', () => {
    const coordinator = createCoordinator(peerA);
    void coordinator.coordinateConnect(peerB, async () => ({ mode: 'auto-signaling' }));
    coordinator.handleTransportState(peerB, 'offer-current', 'signaling');

    expect(coordinator.canApplyAnswer(peerB, 'offer-old')).toBe(false);
    expect(coordinator.canApplyAnswer(peerB, 'offer-current')).toBe(true);

    coordinator.markAnswerApplied(peerB, 'offer-current');
    expect(coordinator.getSnapshot(peerB)).toMatchObject({
      status: 'connecting',
      negotiationId: 'offer-current',
    });
  });

  it('allows a fresh connection after the active negotiation expires', async () => {
    let now = 1000;
    const coordinator = createCoordinator(peerA, { now: () => now });
    const operation = jest.fn(async () => ({ mode: 'auto-signaling' as const }));

    await coordinator.coordinateConnect(peerB, operation);
    expect(coordinator.registerOutbound(peerB, 'offer-old')).toBe(true);

    now += 45_001;
    await coordinator.coordinateConnect(peerB, operation);

    expect(operation).toHaveBeenCalledTimes(2);
    expect(coordinator.getSnapshot(peerB)).toMatchObject({
      direction: 'outbound',
      status: 'negotiating',
    });
  });

  it('marks a session connected and ignores terminal events from an old negotiation', () => {
    const coordinator = createCoordinator(peerB);
    expect(coordinator.considerIncomingOffer(peerA, 'offer-current', 1000).accepted).toBe(true);

    coordinator.handleTransportState(peerA, 'offer-current', 'authenticated');
    coordinator.handleTransportState(peerA, 'offer-old', 'closed');

    expect(coordinator.getSnapshot(peerA)).toMatchObject({
      status: 'connected',
      negotiationId: 'offer-current',
    });
  });

  it('cleans state on peer cancellation and coordinator stop', async () => {
    const deferred = createDeferred<{ mode: 'auto-signaling' }>();
    const coordinator = createCoordinator(peerA);
    const pending = coordinator.coordinateConnect(peerB, () => deferred.promise);

    coordinator.cancelPeer(peerB);
    expect(coordinator.getSnapshot(peerB)).toBeNull();
    expect(coordinator.registerOutbound(peerB, 'cancelled-offer')).toBe(false);

    coordinator.stop();
    expect(coordinator.getSnapshots()).toEqual([]);
    expect(() =>
      coordinator.coordinateConnect(peerB, async () => ({ mode: 'auto-signaling' })),
    ).toThrow('Peer session coordinator is stopped');

    deferred.resolve({ mode: 'auto-signaling' });
    await pending;
  });

  it('waits for a confirmed transport failure before reconnecting', () => {
    jest.useFakeTimers();
    const reconnect = jest.fn(async () => undefined);
    const coordinator = createCoordinator(
      peerA,
      { now: () => Date.now() },
      {
        reconnectPolicy: {
          baseDelayMs: 1000,
          maxDelayMs: 1000,
          jitterRatio: 0,
        },
        canReconnect: () => true,
        onReconnect: reconnect,
      },
    );
    expect(coordinator.considerIncomingOffer(peerB, 'offer-live', Date.now()).accepted).toBe(true);
    coordinator.handleTransportState(peerB, 'offer-live', 'authenticated');

    coordinator.handleTransportState(peerB, 'offer-live', 'disconnected');
    jest.advanceTimersByTime(2000);
    expect(reconnect).not.toHaveBeenCalled();

    coordinator.handleTransportState(peerB, 'offer-live', 'failed', 'WEBRTC_DISCONNECTED_TIMEOUT');
    expect(coordinator.getSnapshot(peerB)).toMatchObject({
      status: 'reconnecting',
      reconnectAttempts: 1,
      failureKind: 'timeout',
    });

    jest.advanceTimersByTime(1000);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledWith(peerB);
  });

  it('uses one deterministic backoff timer per peer', () => {
    jest.useFakeTimers();
    const reconnect = jest.fn(async () => undefined);
    const coordinator = createCoordinator(
      peerA,
      { now: () => Date.now() },
      {
        reconnectPolicy: {
          baseDelayMs: 500,
          maxDelayMs: 500,
          jitterRatio: 0,
        },
        canReconnect: () => true,
        onReconnect: reconnect,
      },
    );

    expect(coordinator.requestReconnect(peerB, 'peer-offline')).toBe(true);
    expect(coordinator.requestReconnect(peerB, 'peer-offline')).toBe(false);
    expect(coordinator.getSnapshot(peerB)).toMatchObject({
      status: 'reconnecting',
      reconnectAttempts: 1,
      nextReconnectAt: Date.now() + 500,
    });

    jest.advanceTimersByTime(499);
    expect(reconnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('cancels scheduled reconnect when the transport recovers', () => {
    jest.useFakeTimers();
    const reconnect = jest.fn(async () => undefined);
    const coordinator = createCoordinator(
      peerA,
      { now: () => Date.now() },
      {
        reconnectPolicy: {
          baseDelayMs: 1000,
          maxDelayMs: 1000,
          jitterRatio: 0,
        },
        canReconnect: () => true,
        onReconnect: reconnect,
      },
    );

    expect(coordinator.requestReconnect(peerB, 'peer-offline')).toBe(true);
    const negotiationId = 'offer-recovered';
    coordinator.handleTransportState(peerB, negotiationId, 'authenticated');
    jest.advanceTimersByTime(1000);

    expect(reconnect).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot(peerB)).toMatchObject({
      status: 'connected',
      reconnectAttempts: 0,
      nextReconnectAt: undefined,
    });
  });

  it('expires a stuck negotiation and schedules a retry', async () => {
    jest.useFakeTimers();
    const reconnect = jest.fn(async () => undefined);
    const timedOut = jest.fn(async () => undefined);
    const coordinator = createCoordinator(
      peerA,
      { now: () => Date.now() },
      {
        reconnectPolicy: {
          negotiationTimeoutMs: 1000,
          baseDelayMs: 250,
          maxDelayMs: 250,
          jitterRatio: 0,
        },
        canReconnect: () => true,
        onReconnect: reconnect,
        onNegotiationTimeout: timedOut,
      },
    );
    await coordinator.coordinateConnect(peerB, async () => ({ mode: 'auto-signaling' }));
    expect(coordinator.registerOutbound(peerB, 'stuck-offer')).toBe(true);

    await jest.advanceTimersByTimeAsync(1000);
    expect(timedOut).toHaveBeenCalledWith(peerB, 'stuck-offer');
    expect(coordinator.getSnapshot(peerB)).toMatchObject({
      status: 'reconnecting',
      failureKind: 'timeout',
    });

    await jest.advanceTimersByTimeAsync(250);
    expect(reconnect).toHaveBeenCalledWith(peerB);
  });
});
