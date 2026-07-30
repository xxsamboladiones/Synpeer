import type { PeerId } from '../NetworkTypes';
import { setLoggerSink, type LoggerSink } from '../../observability/Logger';

type MockSupabaseSubscribeStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';
type MockSupabaseSubscribeCallback = (status: MockSupabaseSubscribeStatus) => void;
type MockSupabaseChannel = {
  topic: string;
  subscribeCallback: MockSupabaseSubscribeCallback | null;
  on: jest.MockedFunction<(type: string, filter: unknown, handler: unknown) => MockSupabaseChannel>;
  subscribe: jest.MockedFunction<(callback: MockSupabaseSubscribeCallback) => MockSupabaseChannel>;
  send: jest.MockedFunction<(message: unknown) => Promise<{ status: string }>>;
  track: jest.MockedFunction<(payload: unknown) => Promise<{ status: string }>>;
  presenceState: jest.MockedFunction<() => Record<string, unknown[]>>;
};

const mockSupabaseChannels: MockSupabaseChannel[] = [];
const mockCreateClient = jest.fn((...args: [string, string, unknown]) => {
  void args;
  return {
    channel: jest.fn((topic: string) => {
      const channel: MockSupabaseChannel = {
        topic: `realtime:${topic}`,
        subscribeCallback: null,
        on: jest.fn((...onArgs: [string, unknown, unknown]) => {
          void onArgs;
          return channel;
        }),
        subscribe: jest.fn((callback: MockSupabaseSubscribeCallback) => {
          channel.subscribeCallback = callback;
          return channel;
        }),
        send: jest.fn(async (message: unknown) => {
          void message;
          return { status: 'ok' };
        }),
        track: jest.fn(async (payload: unknown) => {
          void payload;
          return { status: 'ok' };
        }),
        presenceState: jest.fn(() => ({})),
      };
      mockSupabaseChannels.push(channel);
      return channel;
    }),
    removeChannel: jest.fn(async () => ({ status: 'ok' })),
  };
});

jest.mock('@supabase/supabase-js', () => ({
  __esModule: true,
  createClient: (url: string, key: string, options: unknown) => mockCreateClient(url, key, options),
}));

import {
  BroadcastChannelWebRtcSignaling,
  CompositeWebRtcSignaling,
  createWebRtcAutoSignalMessage,
  decodePrivateNetworkInvite,
  encodePrivateNetworkInvite,
  SupabaseRealtimeWebRtcSignaling,
  validateWebRtcAutoSignalMessage,
  type WebRtcAutoSignalingTransport,
  type WebRtcAutoSignalingStatus,
  WebSocketWebRtcSignaling,
} from '../WebRtcAutoSignaling';

class FakeBroadcastChannel {
  static channels: FakeBroadcastChannel[] = [];

  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly name: string) {
    FakeBroadcastChannel.channels.push(this);
  }

  postMessage(message: unknown): void {
    for (const channel of FakeBroadcastChannel.channels) {
      if (channel !== this && channel.name === this.name) {
        channel.onmessage?.({ data: message });
      }
    }
  }

  close(): void {
    FakeBroadcastChannel.channels = FakeBroadcastChannel.channels.filter(
      (channel) => channel !== this,
    );
  }
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const previousBroadcastChannel = globalThis.BroadcastChannel;
const previousWebSocket = globalThis.WebSocket;
const silentSink: LoggerSink = { write: () => undefined };
const peerA = 'peer-a' as PeerId;
const peerB = 'peer-b' as PeerId;

function installBroadcastChannel(): void {
  FakeBroadcastChannel.channels = [];
  const testGlobal = globalThis as unknown as { BroadcastChannel?: unknown };
  testGlobal.BroadcastChannel = FakeBroadcastChannel;
}

function uninstallBroadcastChannel(): void {
  const testGlobal = globalThis as unknown as { BroadcastChannel?: unknown };
  if (previousBroadcastChannel) {
    testGlobal.BroadcastChannel = previousBroadcastChannel;
  } else {
    delete testGlobal.BroadcastChannel;
  }
}

function installWebSocket(): void {
  FakeWebSocket.instances = [];
  const testGlobal = globalThis as unknown as { WebSocket?: unknown };
  testGlobal.WebSocket = FakeWebSocket;
}

function uninstallWebSocket(): void {
  const testGlobal = globalThis as unknown as { WebSocket?: unknown };
  if (previousWebSocket) {
    testGlobal.WebSocket = previousWebSocket;
  } else {
    delete testGlobal.WebSocket;
  }
}

describe('BroadcastChannelWebRtcSignaling', () => {
  beforeEach(() => {
    setLoggerSink(silentSink);
    installBroadcastChannel();
  });

  afterEach(() => {
    uninstallBroadcastChannel();
  });

  it('delivers addressed signaling messages between browser peers', async () => {
    const sender = new BroadcastChannelWebRtcSignaling(peerA);
    const receiver = new BroadcastChannelWebRtcSignaling(peerB);
    const handler = jest.fn();
    receiver.subscribe(handler);
    sender.start();
    receiver.start();

    await sender.send('offer', peerB, 'synpeer:signal?data=offer');

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'offer',
        fromPeerId: peerA,
        toPeerId: peerB,
      }),
    );
  });

  it('keeps subscribers active after signaling restart', async () => {
    const sender = new BroadcastChannelWebRtcSignaling(peerA);
    const receiver = new BroadcastChannelWebRtcSignaling(peerB);
    const handler = jest.fn();
    receiver.subscribe(handler);
    sender.start();
    receiver.start();

    receiver.stop();
    receiver.start();
    await sender.send('offer', peerB, 'synpeer:signal?data=offer-after-restart');

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'offer',
        fromPeerId: peerA,
        toPeerId: peerB,
        code: 'synpeer:signal?data=offer-after-restart',
      }),
    );
  });

  it('ignores messages addressed to another peer', async () => {
    const message = createWebRtcAutoSignalMessage({
      type: 'answer',
      fromPeerId: peerA,
      toPeerId: 'other-peer' as PeerId,
      code: 'code',
      createdAt: 1000,
      expiresAt: 2000,
    });

    expect(() => validateWebRtcAutoSignalMessage(message, peerB, 1500)).toThrow(
      'Auto signaling message is addressed to another peer',
    );
  });

  it('rejects expired messages before they reach handlers', async () => {
    const receiver = new BroadcastChannelWebRtcSignaling(peerB);
    const handler = jest.fn();
    receiver.subscribe(handler);
    receiver.start();
    FakeBroadcastChannel.channels[0].onmessage?.({
      data: createWebRtcAutoSignalMessage({
        type: 'offer',
        fromPeerId: peerA,
        toPeerId: peerB,
        code: 'code',
        createdAt: 1000,
        expiresAt: 1001,
      }),
    });

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('WebSocketWebRtcSignaling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    setLoggerSink(silentSink);
    globalThis.localStorage?.clear();
    installWebSocket();
  });

  afterEach(() => {
    jest.useRealTimers();
    uninstallWebSocket();
  });

  it('registers the local peer when the WebSocket opens', () => {
    const signaling = new WebSocketWebRtcSignaling(peerA, 'ws://localhost:8787');
    signaling.start();

    FakeWebSocket.instances[0].open();

    expect(JSON.parse(FakeWebSocket.instances[0].sent[0])).toEqual({
      kind: 'hello',
      version: 1,
      peerId: peerA,
    });
  });

  it('queues signals until the WebSocket connection is open', async () => {
    const signaling = new WebSocketWebRtcSignaling(peerA, 'ws://localhost:8787');
    signaling.start();

    await signaling.send('offer', peerB, 'synpeer:signal?data=offer');
    expect(FakeWebSocket.instances[0].sent).toHaveLength(0);

    FakeWebSocket.instances[0].open();

    expect(JSON.parse(FakeWebSocket.instances[0].sent[1])).toMatchObject({
      kind: 'signal',
      message: {
        type: 'offer',
        fromPeerId: peerA,
        toPeerId: peerB,
      },
    });
  });

  it('delivers valid WebSocket signals to subscribers', async () => {
    const signaling = new WebSocketWebRtcSignaling(peerB, 'ws://localhost:8787');
    const handler = jest.fn();
    signaling.subscribe(handler);
    signaling.start();
    FakeWebSocket.instances[0].open();
    const message = createWebRtcAutoSignalMessage({
      type: 'answer',
      fromPeerId: peerA,
      toPeerId: peerB,
      code: 'synpeer:signal?data=answer',
    });

    FakeWebSocket.instances[0].receive({ kind: 'signal', message });

    expect(handler).toHaveBeenCalledWith(message);
  });

  it('reports connected status after the WebSocket opens', () => {
    const signaling = new WebSocketWebRtcSignaling(peerA, 'ws://localhost:8787');
    signaling.start();
    FakeWebSocket.instances[0].open();

    expect(signaling.getStatus()).toMatchObject({
      name: 'websocket',
      available: true,
      state: 'connected',
      pendingMessages: 0,
      reconnectAttempt: 0,
      url: 'ws://localhost:8787',
    });
  });

  it('reconnects when the signaling socket closes unexpectedly', () => {
    const signaling = new WebSocketWebRtcSignaling(peerA, 'ws://localhost:8787');
    signaling.start();

    FakeWebSocket.instances[0].close();
    jest.advanceTimersByTime(1000);

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(signaling.getStatus()).toMatchObject({
      state: 'connecting',
    });
  });

  it('does not reconnect after an intentional stop', () => {
    const signaling = new WebSocketWebRtcSignaling(peerA, 'ws://localhost:8787');
    signaling.start();

    signaling.stop();
    jest.advanceTimersByTime(30000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(signaling.getStatus()).toMatchObject({
      state: 'stopped',
    });
  });

  it('creates a private network invite and registers it on the signaling server', async () => {
    const signaling = new WebSocketWebRtcSignaling(peerA, 'ws://localhost:8787');
    signaling.start();
    FakeWebSocket.instances[0].open();

    const invite = await signaling.createPrivateNetwork('Friends');

    expect(invite).toMatchObject({
      version: 1,
      name: 'Friends',
      ownerPeerId: peerA,
      signalingUrl: 'ws://localhost:8787',
    });
    expect(JSON.parse(FakeWebSocket.instances[0].sent[1])).toMatchObject({
      kind: 'network-create',
      version: 1,
      networkId: invite.networkId,
      name: 'Friends',
    });
  });

  it('persists a joined private network and emits server snapshots to subscribers', async () => {
    const signaling = new WebSocketWebRtcSignaling(peerB, 'ws://localhost:8787');
    const handler = jest.fn();
    signaling.subscribePrivateNetwork?.(handler);
    signaling.start();
    FakeWebSocket.instances[0].open();
    const invite = encodePrivateNetworkInvite({
      version: 1,
      networkId: 'network-1',
      name: 'Friends',
      ownerPeerId: peerA,
      createdAt: 100,
    });

    await signaling.joinPrivateNetwork(invite);
    FakeWebSocket.instances[0].receive({
      kind: 'network-update',
      network: {
        networkId: 'network-1',
        name: 'Friends',
        ownerPeerId: peerA,
        createdAt: 100,
        members: [{ peerId: peerB, status: 'pending', online: true, updatedAt: 200 }],
      },
    });

    expect(JSON.parse(FakeWebSocket.instances[0].sent[1])).toMatchObject({
      kind: 'network-join',
      networkId: 'network-1',
      ownerPeerId: peerA,
    });
    expect(signaling.getPrivateNetworkSnapshot()).toMatchObject({
      networkId: 'network-1',
      members: [{ peerId: peerB, status: 'pending', online: true, updatedAt: 200 }],
    });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ networkId: 'network-1' }));
  });

  it('uses the signaling server URL embedded in a network invite', async () => {
    const signaling = new WebSocketWebRtcSignaling(peerB, 'ws://localhost:8787');
    signaling.start();
    FakeWebSocket.instances[0].open();
    const invite = encodePrivateNetworkInvite({
      version: 1,
      networkId: 'network-remote',
      name: 'Remote Friends',
      ownerPeerId: peerA,
      createdAt: 100,
      signalingUrl: 'ws://192.168.1.10:8787/',
    });

    await signaling.joinPrivateNetwork(invite);

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].url).toBe('ws://192.168.1.10:8787/');
    FakeWebSocket.instances[1].open();
    expect(JSON.parse(FakeWebSocket.instances[1].sent[1])).toMatchObject({
      kind: 'network-join',
      networkId: 'network-remote',
      ownerPeerId: peerA,
    });
  });

  it('round-trips private network invites', () => {
    const invite = {
      version: 1 as const,
      networkId: 'network-1',
      name: 'Friends',
      ownerPeerId: peerA,
      createdAt: 100,
      signalingUrl: 'ws://192.168.1.10:8787/',
    };

    expect(decodePrivateNetworkInvite(encodePrivateNetworkInvite(invite))).toEqual(invite);
  });

  it('continues to decode legacy private network invites', () => {
    const legacyInvite =
      'insta99:network?v=1&networkId=legacy-network&name=Friends&ownerPeerId=peer-a&createdAt=100';

    expect(decodePrivateNetworkInvite(legacyInvite)).toMatchObject({
      networkId: 'legacy-network',
      ownerPeerId: peerA,
      name: 'Friends',
    });
  });
});

describe('SupabaseRealtimeWebRtcSignaling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    setLoggerSink(silentSink);
    mockSupabaseChannels.length = 0;
    mockCreateClient.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('recreates the realtime channel after CHANNEL_ERROR and keeps queued signals', async () => {
    const signaling = new SupabaseRealtimeWebRtcSignaling(
      peerA,
      'https://project.supabase.co',
      'sb_publishable_test',
    );

    signaling.start();
    await signaling.send('offer', peerB, 'synpeer:signal?data=offer');
    mockSupabaseChannels[0].subscribeCallback?.('CHANNEL_ERROR');

    expect(signaling.getStatus()).toMatchObject({
      state: 'reconnecting',
      pendingMessages: 1,
      reconnectAttempt: 1,
    });

    jest.advanceTimersByTime(1000);
    expect(mockSupabaseChannels).toHaveLength(2);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);

    mockSupabaseChannels[1].subscribeCallback?.('SUBSCRIBED');
    await Promise.resolve();

    expect(signaling.getStatus()).toMatchObject({
      state: 'connected',
      pendingMessages: 0,
      reconnectAttempt: 0,
    });
    expect(mockSupabaseChannels[1].send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'broadcast',
        event: 'signal',
      }),
    );
  });

  it('shares one Supabase client between signaling instances for the same project', () => {
    const first = new SupabaseRealtimeWebRtcSignaling(
      peerA,
      'https://shared-project.supabase.co',
      'sb_publishable_shared',
    );
    const second = new SupabaseRealtimeWebRtcSignaling(
      peerB,
      'https://shared-project.supabase.co',
      'sb_publishable_shared',
    );

    first.start();
    second.start();

    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    expect(mockSupabaseChannels).toHaveLength(2);
    expect(mockCreateClient).toHaveBeenCalledWith(
      'https://shared-project.supabase.co',
      'sb_publishable_shared',
      expect.objectContaining({
        auth: expect.objectContaining({
          persistSession: false,
          storageKey: expect.stringMatching(/^synpeer-signaling-/),
        }),
      }),
    );
  });
});

describe('CompositeWebRtcSignaling', () => {
  it('summarizes child transport status for UI snapshots', () => {
    const composite = new CompositeWebRtcSignaling([
      createFakeTransport({ name: 'websocket', available: true, state: 'reconnecting' }),
      createFakeTransport({ name: 'broadcast-channel', available: true, state: 'connected' }),
    ]);

    expect(composite.getStatus()).toMatchObject({
      name: 'composite',
      available: true,
      state: 'connected',
      transports: expect.arrayContaining([
        expect.objectContaining({ name: 'websocket', state: 'reconnecting' }),
        expect.objectContaining({ name: 'broadcast-channel', state: 'connected' }),
      ]),
    });
  });

  it('keeps parent subscribers active after composite restart', async () => {
    let childHandler: (message: ReturnType<typeof createWebRtcAutoSignalMessage>) => void = () =>
      undefined;
    const child = {
      ...createFakeTransport({ name: 'websocket', available: true, state: 'connected' }),
      subscribe: (handler: (message: ReturnType<typeof createWebRtcAutoSignalMessage>) => void) => {
        childHandler = handler;
        return () => {
          childHandler = () => undefined;
        };
      },
    } satisfies WebRtcAutoSignalingTransport;
    const composite = new CompositeWebRtcSignaling([child]);
    const handler = jest.fn();
    composite.subscribe(handler);
    const message = createWebRtcAutoSignalMessage({
      type: 'offer',
      fromPeerId: peerA,
      toPeerId: peerB,
      code: 'synpeer:signal?data=offer-after-composite-restart',
    });

    composite.stop();
    composite.start();
    childHandler?.(message);
    await Promise.resolve();

    expect(handler).toHaveBeenCalledWith(message);
  });
});

function createFakeTransport(
  status: Pick<WebRtcAutoSignalingStatus, 'name' | 'available' | 'state'>,
): WebRtcAutoSignalingTransport {
  return {
    isAvailable: () => status.available,
    start: () => undefined,
    stop: () => undefined,
    subscribe: () => () => undefined,
    send: async () => undefined,
    getStatus: () => ({
      ...status,
      pendingMessages: 0,
      reconnectAttempt: 0,
    }),
  };
}
