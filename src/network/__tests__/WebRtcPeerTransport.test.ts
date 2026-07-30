/* global Event, MessageEvent, RTCDataChannel, RTCDataChannelState, RTCIceConnectionState, RTCIceGatheringState, RTCSessionDescriptionInit, RTCSignalingState, RTCPeerConnectionState */
import { createNetworkMessage } from '../NetworkMessage';
import type { PeerId } from '../NetworkTypes';
import { WebRtcPeerTransport, type WebRtcConfiguration } from '../WebRtcPeerTransport';
import {
  createWebRtcSignalPayload,
  decodeWebRtcSignal,
  encodeWebRtcSignal,
} from '../WebRtcSignaling';

class FakeDataChannel {
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly sent: string[] = [];

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.readyState = 'closed';
    this.onclose?.();
  }

  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }

  receive(message: string): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  static failNextConstruction = false;

  localDescription: RTCSessionDescriptionInit | null = null;
  iceGatheringState: RTCIceGatheringState = 'complete';
  iceConnectionState: RTCIceConnectionState = 'new';
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: Event & { channel?: RTCDataChannel }) => void) | null = null;
  readonly dataChannels: FakeDataChannel[] = [];

  constructor() {
    if (FakePeerConnection.failNextConstruction) {
      FakePeerConnection.failNextConstruction = false;
      throw new Error(
        "Failed to construct 'RTCPeerConnection': Cannot create so many PeerConnections",
      );
    }
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(): RTCDataChannel {
    const channel = new FakeDataChannel();
    this.dataChannels.push(channel);
    return channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'fake-offer-sdp' };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'fake-answer-sdp' };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
    if (description.type === 'offer') {
      this.signalingState = 'have-local-offer';
    }
    if (description.type === 'answer') {
      this.signalingState = 'stable';
    }
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (description.type === 'answer' && this.signalingState === 'stable') {
      throw new Error('Called in wrong state: stable');
    }
    if (description.type === 'answer') {
      this.signalingState = 'stable';
    }
    if (description.type === 'offer') {
      this.signalingState = 'have-remote-offer';
    }
  }

  addEventListener(): void {}

  removeEventListener(): void {}

  close(): void {
    this.connectionState = 'closed';
  }

  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

const previousPeerConnection = globalThis.RTCPeerConnection;
const localPeerId = 'local-peer' as PeerId;
const remotePeerId = 'remote-peer' as PeerId;
const testConfig: WebRtcConfiguration = {
  iceServers: [],
  connectionTimeoutMs: 1,
  disconnectedGracePeriodMs: 1,
  heartbeatIntervalMs: 0,
  maxBufferedAmount: 8,
};

function installWebRtc(): void {
  FakePeerConnection.instances = [];
  FakePeerConnection.failNextConstruction = false;
  const testGlobal = globalThis as unknown as { RTCPeerConnection?: unknown };
  testGlobal.RTCPeerConnection = FakePeerConnection;
}

function uninstallWebRtc(): void {
  const testGlobal = globalThis as unknown as { RTCPeerConnection?: unknown };
  if (previousPeerConnection) {
    testGlobal.RTCPeerConnection = previousPeerConnection;
  } else {
    delete testGlobal.RTCPeerConnection;
  }
}

async function createConnectedTransport(): Promise<{
  transport: WebRtcPeerTransport;
  channel: FakeDataChannel;
}> {
  const transport = new WebRtcPeerTransport(localPeerId, testConfig);
  const offerCode = await transport.createOffer();
  const offer = decodeWebRtcSignal(offerCode);
  const answerCode = encodeWebRtcSignal(
    createWebRtcSignalPayload({
      type: 'answer',
      sessionId: offer.sessionId,
      peerId: remotePeerId,
      description: { type: 'answer', sdp: 'fake-answer-sdp' },
    }),
  );
  await transport.applyAnswer(answerCode);
  const channel = FakePeerConnection.instances[0].dataChannels[0];
  channel.open();
  return { transport, channel };
}

describe('WebRtcPeerTransport', () => {
  beforeEach(() => {
    installWebRtc();
  });

  afterEach(() => {
    jest.useRealTimers();
    uninstallWebRtc();
  });

  it('rejects WebRTC operations when RTCPeerConnection is unavailable', async () => {
    uninstallWebRtc();
    const transport = new WebRtcPeerTransport(localPeerId, testConfig);

    await expect(transport.createOffer()).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });

  it('sends NetworkMessage envelopes over an open data channel', async () => {
    const { transport, channel } = await createConnectedTransport();
    const message = createNetworkMessage({
      messageType: 'sync.manifest',
      senderId: localPeerId,
      payload: { cursor: 'cursor-1' },
    });

    await transport.send(remotePeerId, message);

    expect(channel.sent).toHaveLength(1);
    expect(JSON.parse(channel.sent[0])).toMatchObject({
      messageId: message.messageId,
      messageType: 'sync.manifest',
      senderId: localPeerId,
    });
    expect(transport.getStats()).toMatchObject({ messagesSent: 1 });
  });

  it('rejects sends when the data channel is congested', async () => {
    const { transport, channel } = await createConnectedTransport();
    channel.bufferedAmount = testConfig.maxBufferedAmount + 1;
    const message = createNetworkMessage({
      messageType: 'sync.manifest',
      senderId: localPeerId,
      payload: { cursor: 'cursor-1' },
    });

    await expect(transport.send(remotePeerId, message)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });

  it('reports pending outbound offers and rejects answers for missing sessions safely', async () => {
    const transport = new WebRtcPeerTransport(localPeerId, testConfig);
    const offerCode = await transport.createOffer();
    const offer = decodeWebRtcSignal(offerCode);

    expect(transport.hasPendingOutboundSession(offer.sessionId)).toBe(true);

    const otherAnswer = encodeWebRtcSignal(
      createWebRtcSignalPayload({
        type: 'answer',
        sessionId: 'missing-session',
        peerId: remotePeerId,
        description: { type: 'answer', sdp: 'fake-answer-sdp' },
      }),
    );

    await expect(transport.applyAnswer(otherAnswer)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      safeMessage:
        'Esta resposta nao pertence a uma oferta ativa neste navegador. Crie uma nova oferta e gere uma nova resposta.',
    });
  });

  it('rekeys an outbound connection when the answer arrives after the data channel opens', async () => {
    const transport = new WebRtcPeerTransport(localPeerId, testConfig);
    const listener = jest.fn();
    transport.onConnectionOpen(listener);
    const offerCode = await transport.createOffer();
    const offer = decodeWebRtcSignal(offerCode);
    const channel = FakePeerConnection.instances[0].dataChannels[0];
    channel.open();

    expect(transport.getConnectedPeers()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();

    const answerCode = encodeWebRtcSignal(
      createWebRtcSignalPayload({
        type: 'answer',
        sessionId: offer.sessionId,
        peerId: remotePeerId,
        description: { type: 'answer', sdp: 'fake-answer-sdp' },
      }),
    );
    await transport.applyAnswer(answerCode);

    expect(transport.getConnectedPeers()).toEqual([remotePeerId]);
    expect(transport.getConnection(remotePeerId)).toMatchObject({ peerId: remotePeerId });
    expect(listener).toHaveBeenCalledWith(remotePeerId, offer.sessionId);
  });

  it('ignores duplicated auto-signaling answers after the peer connection is stable', async () => {
    const transport = new WebRtcPeerTransport(localPeerId, testConfig);
    const offerCode = await transport.createOffer();
    const offer = decodeWebRtcSignal(offerCode);
    const answerCode = encodeWebRtcSignal(
      createWebRtcSignalPayload({
        type: 'answer',
        sessionId: offer.sessionId,
        peerId: remotePeerId,
        description: { type: 'answer', sdp: 'fake-answer-sdp' },
      }),
    );

    await transport.applyAnswer(answerCode);
    await expect(transport.applyAnswer(answerCode)).resolves.toBeUndefined();

    expect(transport.getSessions()).toEqual([
      expect.objectContaining({
        sessionId: offer.sessionId,
        peerId: remotePeerId,
        state: 'connecting',
      }),
    ]);
  });

  it('closes superseded inbound sessions before accepting a new offer from the same peer', async () => {
    const transport = new WebRtcPeerTransport(localPeerId, testConfig);
    const firstOffer = encodeWebRtcSignal(
      createWebRtcSignalPayload({
        type: 'offer',
        sessionId: 'remote-session-1',
        peerId: remotePeerId,
        description: { type: 'offer', sdp: 'fake-offer-sdp-1' },
      }),
    );
    const secondOffer = encodeWebRtcSignal(
      createWebRtcSignalPayload({
        type: 'offer',
        sessionId: 'remote-session-2',
        peerId: remotePeerId,
        description: { type: 'offer', sdp: 'fake-offer-sdp-2' },
      }),
    );

    await transport.acceptOffer(firstOffer);
    await transport.acceptOffer(secondOffer);

    expect(transport.getSessions()).toEqual([
      expect.objectContaining({
        sessionId: 'remote-session-2',
        peerId: remotePeerId,
        state: 'connecting',
      }),
    ]);
    expect(FakePeerConnection.instances[0].connectionState).toBe('closed');
  });

  it('binds outbound offers to the target peer and keeps one negotiation per peer', async () => {
    const transport = new WebRtcPeerTransport(localPeerId, testConfig);

    const firstOffer = decodeWebRtcSignal(await transport.createOffer(remotePeerId));
    const secondOffer = decodeWebRtcSignal(await transport.createOffer(remotePeerId));

    expect(firstOffer.peerId).toBe(localPeerId);
    expect(secondOffer.peerId).toBe(localPeerId);
    expect(transport.getSessions()).toEqual([
      expect.objectContaining({
        sessionId: secondOffer.sessionId,
        peerId: remotePeerId,
        direction: 'outbound',
        state: 'signaling',
      }),
    ]);
    expect(FakePeerConnection.instances[0].connectionState).toBe('closed');
  });

  it('closes a cancelled negotiation by session id', async () => {
    const transport = new WebRtcPeerTransport(localPeerId, testConfig);
    const offer = decodeWebRtcSignal(await transport.createOffer(remotePeerId));

    await transport.closeNegotiation(offer.sessionId);

    expect(transport.getSessions()).toEqual([]);
    expect(FakePeerConnection.instances[0].connectionState).toBe('closed');
  });

  it('recovers from browser PeerConnection limits by closing managed sessions once', async () => {
    const transport = new WebRtcPeerTransport(localPeerId, testConfig);
    const listener = jest.fn();
    transport.onSessionStateChange(listener);
    await transport.createOffer();
    FakePeerConnection.failNextConstruction = true;

    const recoveredOffer = await transport.createOffer();
    const recoveredSignal = decodeWebRtcSignal(recoveredOffer);

    expect(recoveredSignal.type).toBe('offer');
    expect(transport.getSessions()).toEqual([
      expect.objectContaining({
        sessionId: recoveredSignal.sessionId,
        state: 'signaling',
      }),
    ]);
    expect(listener).toHaveBeenCalled();
    expect(FakePeerConnection.instances).toHaveLength(2);
    expect(FakePeerConnection.instances[0].connectionState).toBe('closed');
  });

  it('notifies session state changes for reconnect and UI session tracking', async () => {
    const transport = new WebRtcPeerTransport(localPeerId, testConfig);
    const listener = jest.fn();
    transport.onSessionStateChange(listener);
    const offerCode = await transport.createOffer();
    const offer = decodeWebRtcSignal(offerCode);
    const answerCode = encodeWebRtcSignal(
      createWebRtcSignalPayload({
        type: 'answer',
        sessionId: offer.sessionId,
        peerId: remotePeerId,
        description: { type: 'answer', sdp: 'fake-answer-sdp' },
      }),
    );
    await transport.applyAnswer(answerCode);
    const channel = FakePeerConnection.instances[0].dataChannels[0];
    channel.open();
    transport.markAuthenticated(remotePeerId);
    channel.close();

    const remoteStates = listener.mock.calls
      .map(([session]) => session)
      .filter((session) => session.peerId === remotePeerId)
      .map((session) => session.state);

    expect(remoteStates).toEqual(['connecting', 'connected', 'authenticated', 'disconnected']);
  });

  it('delivers valid incoming messages and deduplicates repeats', async () => {
    const { transport, channel } = await createConnectedTransport();
    const handler = jest.fn();
    transport.subscribe(handler);
    const message = createNetworkMessage({
      messageType: 'sync.manifest',
      senderId: remotePeerId,
      payload: { cursor: 'cursor-1' },
    });
    const wireMessage = JSON.stringify(message);

    channel.receive(wireMessage);
    channel.receive(wireMessage);

    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(transport.getStats()).toMatchObject({
      messagesReceived: 1,
      messagesRejected: 1,
    });
  });

  it('keeps open data channels alive with transport heartbeats', async () => {
    jest.useFakeTimers();
    const transport = new WebRtcPeerTransport(localPeerId, {
      ...testConfig,
      heartbeatIntervalMs: 1000,
    });
    const offerCode = await transport.createOffer();
    const offer = decodeWebRtcSignal(offerCode);
    const answerCode = encodeWebRtcSignal(
      createWebRtcSignalPayload({
        type: 'answer',
        sessionId: offer.sessionId,
        peerId: remotePeerId,
        description: { type: 'answer', sdp: 'fake-answer-sdp' },
      }),
    );
    await transport.applyAnswer(answerCode);
    const channel = FakePeerConnection.instances[0].dataChannels[0];
    channel.open();

    jest.advanceTimersByTime(1000);

    expect(channel.sent).toHaveLength(1);
    expect(JSON.parse(channel.sent[0])).toMatchObject({
      messageType: 'peer.heartbeat',
      senderId: localPeerId,
    });
    expect(transport.getConnectedPeers()).toEqual([remotePeerId]);
  });

  it('consumes incoming heartbeats without dispatching them to protocol handlers', async () => {
    const { transport, channel } = await createConnectedTransport();
    const handler = jest.fn();
    transport.subscribe(handler);
    const heartbeat = createNetworkMessage({
      messageType: 'peer.heartbeat',
      senderId: remotePeerId,
      payload: { sessionId: 'session-1', sentAt: Date.now() },
    });

    channel.receive(JSON.stringify(heartbeat));

    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    expect(transport.getStats()).toMatchObject({ messagesReceived: 1 });
  });

  it('keeps the session when a transient disconnect recovers inside the grace period', async () => {
    jest.useFakeTimers();
    const { transport } = await createConnectedTransport();
    const connection = FakePeerConnection.instances[0];

    connection.setConnectionState('disconnected');
    expect(transport.getSessions()).toEqual([
      expect.objectContaining({ peerId: remotePeerId, state: 'disconnected' }),
    ]);

    connection.setConnectionState('connected');
    jest.advanceTimersByTime(testConfig.disconnectedGracePeriodMs);

    expect(transport.getSessions()).toEqual([
      expect.objectContaining({ peerId: remotePeerId, state: 'connected' }),
    ]);
    expect(transport.getConnectedPeers()).toEqual([remotePeerId]);
  });

  it('closes and releases a session after the disconnect grace period expires', async () => {
    jest.useFakeTimers();
    const { transport } = await createConnectedTransport();
    const listener = jest.fn();
    transport.onSessionStateChange(listener);
    const connection = FakePeerConnection.instances[0];

    connection.setConnectionState('disconnected');
    await jest.advanceTimersByTimeAsync(testConfig.disconnectedGracePeriodMs);

    expect(transport.getSessions()).toEqual([]);
    expect(transport.getConnectedPeers()).toEqual([]);
    expect(connection.connectionState).toBe('closed');
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        peerId: remotePeerId,
        state: 'failed',
        failureCode: 'WEBRTC_DISCONNECTED_TIMEOUT',
      }),
    );
  });

  it('closes a silent session when peer heartbeats stop', async () => {
    jest.useFakeTimers();
    const transport = new WebRtcPeerTransport(localPeerId, {
      ...testConfig,
      disconnectedGracePeriodMs: 1000,
      heartbeatIntervalMs: 1000,
    });
    const offerCode = await transport.createOffer();
    const offer = decodeWebRtcSignal(offerCode);
    const answerCode = encodeWebRtcSignal(
      createWebRtcSignalPayload({
        type: 'answer',
        sessionId: offer.sessionId,
        peerId: remotePeerId,
        description: { type: 'answer', sdp: 'fake-answer-sdp' },
      }),
    );
    await transport.applyAnswer(answerCode);
    const channel = FakePeerConnection.instances[0].dataChannels[0];
    channel.open();

    await jest.advanceTimersByTimeAsync(4000);

    expect(transport.getSessions()).toEqual([]);
    expect(transport.getStats()).toMatchObject({
      connectionsFailed: 1,
      lastError: 'WEBRTC_HEARTBEAT_TIMEOUT',
    });
  });
});
