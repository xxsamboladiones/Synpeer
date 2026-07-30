/* global Event, MessageEvent, RTCDataChannel, RTCIceServer, RTCIceTransportPolicy, RTCPeerConnection, RTCPeerConnectionState */
import { AppError } from '@/errors/AppError';
import { createLogger } from '@/observability/Logger';

import {
  createNetworkMessage,
  MAX_NETWORK_MESSAGE_BYTES,
  NetworkMessageDeduplicator,
  type NetworkMessage,
  validateNetworkMessage,
} from './NetworkMessage';
import type { PeerConnection, PeerTransport, PeerTransportHandler } from './PeerTransport';
import type { PeerId } from './NetworkTypes';
import {
  createWebRtcSessionId,
  createWebRtcSignalPayload,
  decodeWebRtcSignal,
  defaultPeerCapabilities,
  encodeWebRtcSignal,
  type PeerCapabilities,
} from './WebRtcSignaling';

export type WebRtcSessionState =
  | 'created'
  | 'signaling'
  | 'connecting'
  | 'connected'
  | 'authenticated'
  | 'disconnected'
  | 'failed'
  | 'closed';

export interface WebRtcConfiguration {
  iceServers: RTCIceServer[];
  iceTransportPolicy?: RTCIceTransportPolicy;
  connectionTimeoutMs: number;
  disconnectedGracePeriodMs: number;
  heartbeatIntervalMs: number;
  maxBufferedAmount: number;
}

export interface WebRtcSessionSnapshot {
  sessionId: string;
  peerId: PeerId;
  direction: 'inbound' | 'outbound';
  state: WebRtcSessionState;
  createdAt: number;
  connectedAt?: number;
  authenticatedAt?: number;
  disconnectedAt?: number;
  lastSeenAt?: number;
  retryCount: number;
  failureCode?: string;
}

export interface WebRtcTransportStats {
  sessionsCreated: number;
  connectionsOpened: number;
  connectionsFailed: number;
  messagesSent: number;
  messagesReceived: number;
  messagesRejected: number;
  bytesSent: number;
  bytesReceived: number;
  lastMessageAt?: number;
  lastError?: string;
}

export type WebRtcSessionStateListener = (snapshot: WebRtcSessionSnapshot) => void;

export const defaultWebRtcConfiguration: WebRtcConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  connectionTimeoutMs: 30000,
  disconnectedGracePeriodMs: 10000,
  heartbeatIntervalMs: 15000,
  maxBufferedAmount: 1024 * 1024,
};

const MAX_ACTIVE_WEBRTC_SESSIONS = 12;
const STALE_SIGNALING_SESSION_MS = 45000;

type RtcDataChannelEvent = Event & { channel?: RTCDataChannel };

type InternalSession = WebRtcSessionSnapshot & {
  peerConnection: RTCPeerConnection;
  dataChannel: RTCDataChannel | null;
  remoteDescriptionApplied: boolean;
  heartbeatTimer: ReturnType<typeof globalThis.setInterval> | null;
  disconnectTimer: ReturnType<typeof globalThis.setTimeout> | null;
  closing: boolean;
};

export class WebRtcPeerTransport implements PeerTransport {
  private readonly logger = createLogger('webrtc.peer.transport');
  private readonly handlers = new Set<PeerTransportHandler>();
  private readonly deduplicator = new NetworkMessageDeduplicator();
  private readonly sessions = new Map<string, InternalSession>();
  private readonly sessionsByPeer = new Map<PeerId, string>();
  private readonly connections = new Map<PeerId, WebRtcPeerConnection>();
  private readonly connectionListeners = new Set<(peerId: PeerId, sessionId: string) => void>();
  private readonly sessionStateListeners = new Set<WebRtcSessionStateListener>();
  private stats: WebRtcTransportStats = {
    sessionsCreated: 0,
    connectionsOpened: 0,
    connectionsFailed: 0,
    messagesSent: 0,
    messagesReceived: 0,
    messagesRejected: 0,
    bytesSent: 0,
    bytesReceived: 0,
  };

  constructor(
    readonly localPeerId: PeerId,
    private readonly config: WebRtcConfiguration = defaultWebRtcConfiguration,
    private readonly capabilities: PeerCapabilities = defaultPeerCapabilities,
  ) {}

  isAvailable(): boolean {
    return typeof globalThis.RTCPeerConnection !== 'undefined';
  }

  async createOffer(peerId: PeerId = this.localPeerId): Promise<string> {
    this.assertAvailable();
    await this.pruneStaleSessions();
    const sessionId = createWebRtcSessionId(this.localPeerId);
    if (peerId !== this.localPeerId) {
      if (this.getConnection(peerId)) {
        throw this.createError(
          'Peer already has an open WebRTC session',
          'offer-already-connected',
        );
      }
      await this.closeSupersededPeerSessions(peerId, sessionId);
    }
    this.enforceSessionBudget();
    const peerConnection = await this.createPeerConnectionWithRecovery(sessionId);
    const dataChannel = peerConnection.createDataChannel('synpeer');
    const session = this.createSession(sessionId, peerId, 'outbound', peerConnection);
    session.dataChannel = dataChannel;
    this.configureDataChannel(session, dataChannel);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await this.waitForIceGathering(peerConnection);
    const description = peerConnection.localDescription;
    if (!description?.sdp || description.type !== 'offer') {
      throw this.createError('Failed to create WebRTC offer', 'offer');
    }
    const payload = createWebRtcSignalPayload({
      type: 'offer',
      sessionId,
      peerId: this.localPeerId,
      description: { type: 'offer', sdp: description.sdp },
      capabilities: this.capabilities,
    });
    session.state = 'signaling';
    this.emitSessionState(session);
    return encodeWebRtcSignal(payload);
  }

  async acceptOffer(code: string): Promise<string> {
    this.assertAvailable();
    const offer = decodeWebRtcSignal(code);
    if (offer.type !== 'offer' || offer.description.type !== 'offer') {
      throw this.createError('Expected WebRTC offer signaling payload', 'accept-offer');
    }
    if (this.getConnection(offer.peerId)) {
      throw this.createError(
        'Peer already has an open WebRTC session',
        'accept-offer-already-connected',
      );
    }
    await this.closeSupersededPeerSessions(offer.peerId, offer.sessionId);
    await this.pruneStaleSessions();
    this.enforceSessionBudget();

    const peerConnection = await this.createPeerConnectionWithRecovery(offer.sessionId);
    const session = this.createSession(offer.sessionId, offer.peerId, 'inbound', peerConnection);
    peerConnection.ondatachannel = (event: RtcDataChannelEvent) => {
      const channel = event.channel;
      if (channel) {
        session.dataChannel = channel;
        this.configureDataChannel(session, channel);
      }
    };
    await peerConnection.setRemoteDescription(offer.description);
    session.remoteDescriptionApplied = true;
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    await this.waitForIceGathering(peerConnection);
    const description = peerConnection.localDescription;
    if (!description?.sdp || description.type !== 'answer') {
      throw this.createError('Failed to create WebRTC answer', 'answer');
    }
    const payload = createWebRtcSignalPayload({
      type: 'answer',
      sessionId: offer.sessionId,
      peerId: this.localPeerId,
      description: { type: 'answer', sdp: description.sdp },
      capabilities: this.capabilities,
    });
    session.state = 'connecting';
    this.emitSessionState(session);
    return encodeWebRtcSignal(payload);
  }

  async applyAnswer(code: string): Promise<void> {
    const answer = decodeWebRtcSignal(code);
    if (answer.type !== 'answer' || answer.description.type !== 'answer') {
      throw this.createError('Expected WebRTC answer signaling payload', 'apply-answer');
    }
    const session = this.sessions.get(answer.sessionId);
    if (!session) {
      throw this.createError(
        'WebRTC session not found for answer. Create a new offer in this browser and generate a fresh answer from it.',
        'apply-answer',
      );
    }
    if (session.peerId !== answer.peerId) {
      this.connections.delete(session.peerId);
      this.sessionsByPeer.delete(session.peerId);
    }
    session.peerId = answer.peerId;
    this.sessionsByPeer.set(answer.peerId, answer.sessionId);
    if (this.shouldIgnoreDuplicateAnswer(session)) {
      this.logger.warn('duplicate_answer_ignored', {
        peerId: answer.peerId,
        sessionId: answer.sessionId,
        state: session.state,
      });
      return;
    }
    await session.peerConnection.setRemoteDescription(answer.description);
    session.remoteDescriptionApplied = true;
    session.state = 'connecting';
    this.emitSessionState(session);
    const connection = this.refreshConnectionForSession(session);
    if (connection && session.connectedAt) {
      for (const listener of this.connectionListeners) {
        listener(connection.peerId, session.sessionId);
      }
    }
  }

  async connect(remote: PeerTransport): Promise<PeerConnection> {
    void remote;
    throw this.createError(
      'WebRTC transport uses manual signaling instead of direct connect',
      'connect',
    );
  }

  async disconnect(peerId: PeerId): Promise<void> {
    const sessionId = this.sessionsByPeer.get(peerId);
    if (!sessionId) {
      return;
    }
    await this.closeSession(sessionId, 'closed');
  }

  async closeNegotiation(sessionId: string): Promise<void> {
    await this.closeSession(sessionId, 'closed');
    this.removeSession(sessionId);
  }

  async send(peerId: PeerId, message: NetworkMessage): Promise<void> {
    const connection = this.connections.get(peerId);
    if (!connection) {
      throw this.createError(`Peer ${peerId} is not connected`, 'send');
    }
    await connection.sendMessage(message);
  }

  subscribe(handler: PeerTransportHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onConnectionOpen(listener: (peerId: PeerId, sessionId: string) => void): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  onSessionStateChange(listener: WebRtcSessionStateListener): () => void {
    this.sessionStateListeners.add(listener);
    return () => {
      this.sessionStateListeners.delete(listener);
    };
  }

  markAuthenticated(peerId: PeerId): void {
    const sessionId = this.sessionsByPeer.get(peerId);
    const session = sessionId ? this.sessions.get(sessionId) : null;
    if (session) {
      session.state = 'authenticated';
      session.authenticatedAt = Date.now();
      this.emitSessionState(session);
    }
  }

  getConnection(peerId: PeerId): PeerConnection | null {
    const connection = this.connections.get(peerId);
    if (!connection) {
      return null;
    }
    if (!this.isPeerChannelOpen(peerId)) {
      this.connections.delete(peerId);
      return null;
    }
    return connection;
  }

  getConnectedPeers(): PeerId[] {
    return Array.from(this.connections.keys()).filter((peerId) =>
      Boolean(this.getConnection(peerId)),
    );
  }

  getSessions(): WebRtcSessionSnapshot[] {
    return Array.from(this.sessions.values()).map((session) => this.toSessionSnapshot(session));
  }

  hasPendingOutboundSession(sessionId?: string): boolean {
    return Array.from(this.sessions.values()).some(
      (session) =>
        session.direction === 'outbound' &&
        session.state === 'signaling' &&
        (!sessionId || session.sessionId === sessionId),
    );
  }

  getStats(): WebRtcTransportStats {
    return { ...this.stats };
  }

  async pruneStaleSessions(now = Date.now()): Promise<void> {
    for (const session of Array.from(this.sessions.values())) {
      const isTerminal = session.state === 'closed' || session.state === 'failed';
      const isStaleSignaling =
        (session.state === 'created' ||
          session.state === 'signaling' ||
          session.state === 'connecting' ||
          session.state === 'disconnected') &&
        now - session.createdAt > STALE_SIGNALING_SESSION_MS;
      if (isTerminal || isStaleSignaling) {
        await this.closeSession(
          session.sessionId,
          session.state === 'failed' ? 'failed' : 'closed',
        );
        this.removeSession(session.sessionId);
      }
    }
  }

  async closeAll(): Promise<void> {
    for (const sessionId of Array.from(this.sessions.keys())) {
      await this.closeSession(sessionId, 'closed');
      this.removeSession(sessionId);
    }
    this.handlers.clear();
    this.connectionListeners.clear();
    this.sessionStateListeners.clear();
  }

  private createPeerConnection(sessionId: string): RTCPeerConnection {
    const peerConnection = new RTCPeerConnection({
      iceServers: this.config.iceServers,
      iceTransportPolicy: this.config.iceTransportPolicy,
    });
    peerConnection.onconnectionstatechange = () => {
      this.handleConnectionState(sessionId, peerConnection.connectionState);
    };
    peerConnection.oniceconnectionstatechange = () => {
      if (peerConnection.iceConnectionState === 'failed') {
        this.handleConnectionState(sessionId, 'failed');
      }
    };
    return peerConnection;
  }

  private async createPeerConnectionWithRecovery(sessionId: string): Promise<RTCPeerConnection> {
    try {
      return this.createPeerConnection(sessionId);
    } catch (error) {
      if (!isPeerConnectionLimitError(error)) {
        throw error;
      }
      this.logger.warn('peer_connection_limit_recovery_started', {
        sessionId,
        activeSessions: this.sessions.size,
      });
      await this.closeManagedSessions('closed');
      try {
        const peerConnection = this.createPeerConnection(sessionId);
        this.logger.info('peer_connection_limit_recovery_completed', { sessionId });
        return peerConnection;
      } catch (retryError) {
        this.stats.lastError =
          retryError instanceof Error ? retryError.message : 'peer-connection-create-failed';
        throw retryError;
      }
    }
  }

  private async closeManagedSessions(state: WebRtcSessionState): Promise<void> {
    for (const sessionId of Array.from(this.sessions.keys())) {
      await this.closeSession(sessionId, state);
      this.removeSession(sessionId);
    }
  }

  private createSession(
    sessionId: string,
    peerId: PeerId,
    direction: 'inbound' | 'outbound',
    peerConnection: RTCPeerConnection,
  ): InternalSession {
    const session: InternalSession = {
      sessionId,
      peerId,
      direction,
      state: 'created',
      createdAt: Date.now(),
      retryCount: 0,
      peerConnection,
      dataChannel: null,
      remoteDescriptionApplied: false,
      heartbeatTimer: null,
      disconnectTimer: null,
      closing: false,
    };
    this.sessions.set(sessionId, session);
    if (peerId !== this.localPeerId) {
      this.sessionsByPeer.set(peerId, sessionId);
    }
    this.stats.sessionsCreated += 1;
    this.emitSessionState(session);
    return session;
  }

  private configureDataChannel(session: InternalSession, dataChannel: RTCDataChannel): void {
    dataChannel.onopen = () => {
      session.state = 'connected';
      session.connectedAt = Date.now();
      session.lastSeenAt = session.connectedAt;
      const connection = this.refreshConnectionForSession(session);
      this.stats.connectionsOpened += 1;
      this.startHeartbeat(session);
      this.emitSessionState(session);
      if (connection) {
        for (const listener of this.connectionListeners) {
          listener(connection.peerId, session.sessionId);
        }
      }
    };
    dataChannel.onclose = () => {
      this.handleDataChannelClosed(session.sessionId);
    };
    dataChannel.onerror = () => {
      this.stats.connectionsFailed += 1;
      this.stats.lastError = 'data-channel-error';
      void this.closeSession(session.sessionId, 'failed');
    };
    dataChannel.onmessage = (event: MessageEvent) => {
      void this.receive(session, event.data);
    };
  }

  private refreshConnectionForSession(session: InternalSession): WebRtcPeerConnection | null {
    if (!session.connectedAt || session.peerId === this.localPeerId) {
      return null;
    }
    const connection = new WebRtcPeerConnection(
      this,
      session.peerId,
      session.sessionId,
      session.connectedAt,
    );
    this.connections.set(session.peerId, connection);
    this.sessionsByPeer.set(session.peerId, session.sessionId);
    return connection;
  }

  private async receive(session: InternalSession, data: unknown): Promise<void> {
    if (typeof data !== 'string') {
      this.reject('non-string-message');
      return;
    }
    this.stats.bytesReceived += data.length;
    this.stats.lastMessageAt = Date.now();

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.reject('malformed-json');
      return;
    }
    const validation = validateNetworkMessage(parsed);
    if (!validation.valid) {
      this.reject(validation.error);
      return;
    }
    if (validation.message.senderId !== session.peerId) {
      this.reject('sender-mismatch');
      return;
    }
    if (!this.deduplicator.accept(validation.message)) {
      this.reject('duplicate');
      return;
    }
    if (validation.message.messageType === 'peer.heartbeat') {
      session.lastSeenAt = Date.now();
      this.stats.messagesReceived += 1;
      return;
    }
    const connection = this.connections.get(session.peerId);
    if (!connection) {
      this.reject('missing-connection');
      return;
    }
    session.lastSeenAt = Date.now();
    this.stats.messagesReceived += 1;
    for (const handler of this.handlers) {
      try {
        await handler(validation.message, connection);
      } catch (error) {
        this.stats.lastError = error instanceof Error ? error.message : 'handler-failed';
        this.logger.warn('message_handler_failed', {
          peerId: session.peerId,
          messageType: validation.message.messageType,
        });
      }
    }
  }

  private reject(reason: string): void {
    this.stats.messagesRejected += 1;
    this.stats.lastError = reason;
    this.logger.warn('message_rejected', { reason });
  }

  private shouldIgnoreDuplicateAnswer(session: InternalSession): boolean {
    const signalingState = session.peerConnection.signalingState;
    return session.remoteDescriptionApplied || signalingState === 'stable';
  }

  private handleConnectionState(sessionId: string, state: RTCPeerConnectionState | 'failed'): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    if (state === 'connected') {
      this.stopDisconnectTimer(session);
      if (session.state === 'disconnected' && session.dataChannel?.readyState === 'open') {
        session.state = session.authenticatedAt ? 'authenticated' : 'connected';
        session.disconnectedAt = undefined;
        session.lastSeenAt = Date.now();
        this.startHeartbeat(session);
        this.emitSessionState(session);
      }
      return;
    }
    if (state === 'failed') {
      session.failureCode = 'WEBRTC_CONNECTION_FAILED';
      this.stats.connectionsFailed += 1;
      this.stats.lastError = session.failureCode;
      void this.closeSession(session.sessionId, 'failed');
      return;
    }
    if (state === 'disconnected') {
      session.state = 'disconnected';
      session.disconnectedAt = Date.now();
      this.scheduleDisconnectTimeout(session, 'WEBRTC_DISCONNECTED_TIMEOUT');
      this.emitSessionState(session);
      return;
    }
    if (state === 'closed') {
      session.state = 'closed';
      session.disconnectedAt = Date.now();
      this.stopHeartbeat(session);
      this.stopDisconnectTimer(session);
      this.connections.delete(session.peerId);
      this.emitSessionState(session);
      this.removeSession(session.sessionId);
    }
  }

  private async closeSession(sessionId: string, state: WebRtcSessionState): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    if (session.closing && (session.state === 'closed' || session.state === 'failed')) {
      return;
    }
    session.closing = true;
    this.stopHeartbeat(session);
    this.stopDisconnectTimer(session);
    session.state = state;
    session.disconnectedAt = Date.now();
    if (session.dataChannel && session.dataChannel.readyState !== 'closed') {
      session.dataChannel.close();
    }
    if (session.peerConnection.connectionState !== 'closed') {
      session.peerConnection.close();
    }
    this.connections.delete(session.peerId);
    this.emitSessionState(session);
    if (state === 'closed' || state === 'failed') {
      this.removeSession(session.sessionId);
    }
  }

  private handleDataChannelClosed(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    this.stopHeartbeat(session);
    if (session.closing) {
      return;
    }
    session.state = 'disconnected';
    session.disconnectedAt = Date.now();
    this.connections.delete(session.peerId);
    this.emitSessionState(session);
    this.scheduleDisconnectTimeout(session, 'WEBRTC_DATA_CHANNEL_TIMEOUT');
  }

  private async closeSupersededPeerSessions(peerId: PeerId, nextSessionId: string): Promise<void> {
    for (const session of Array.from(this.sessions.values())) {
      if (session.peerId !== peerId || session.sessionId === nextSessionId) {
        continue;
      }
      if (session.state === 'authenticated' && this.getOpenDataChannel(session.sessionId)) {
        continue;
      }
      await this.closeSession(session.sessionId, 'closed');
      this.removeSession(session.sessionId);
    }
  }

  private enforceSessionBudget(): void {
    const activeSessions = Array.from(this.sessions.values()).filter(
      (session) => session.state !== 'closed' && session.state !== 'failed',
    );
    if (activeSessions.length < MAX_ACTIVE_WEBRTC_SESSIONS) {
      return;
    }
    throw this.createError('WebRTC session limit reached', 'session-budget');
  }

  private removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    this.sessions.delete(sessionId);
    if (this.sessionsByPeer.get(session.peerId) === sessionId) {
      this.sessionsByPeer.delete(session.peerId);
    }
    if (this.connections.get(session.peerId)?.peerId === session.peerId) {
      const mappedSessionId = this.sessionsByPeer.get(session.peerId);
      if (!mappedSessionId) {
        this.connections.delete(session.peerId);
      }
    }
  }

  private toSessionSnapshot(session: InternalSession): WebRtcSessionSnapshot {
    return {
      sessionId: session.sessionId,
      peerId: session.peerId,
      direction: session.direction,
      state: session.state,
      createdAt: session.createdAt,
      connectedAt: session.connectedAt,
      authenticatedAt: session.authenticatedAt,
      disconnectedAt: session.disconnectedAt,
      lastSeenAt: session.lastSeenAt,
      retryCount: session.retryCount,
      failureCode: session.failureCode,
    };
  }

  private emitSessionState(session: InternalSession): void {
    if (this.sessionStateListeners.size === 0) {
      return;
    }
    const snapshot = this.toSessionSnapshot(session);
    for (const listener of this.sessionStateListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.stats.lastError = error instanceof Error ? error.message : 'session-listener-failed';
        this.logger.warn('session_state_listener_failed', {
          peerId: snapshot.peerId,
          sessionId: snapshot.sessionId,
          state: snapshot.state,
        });
      }
    }
  }

  private startHeartbeat(session: InternalSession): void {
    this.stopHeartbeat(session);
    if (this.config.heartbeatIntervalMs <= 0) {
      return;
    }
    session.heartbeatTimer = globalThis.setInterval(() => {
      void this.sendHeartbeat(session);
    }, this.config.heartbeatIntervalMs);
  }

  private stopHeartbeat(session: InternalSession): void {
    if (!session.heartbeatTimer) {
      return;
    }
    globalThis.clearInterval(session.heartbeatTimer);
    session.heartbeatTimer = null;
  }

  private async sendHeartbeat(session: InternalSession): Promise<void> {
    if (session.closing || session.state === 'closed' || session.state === 'failed') {
      this.stopHeartbeat(session);
      return;
    }
    const channel = session.dataChannel;
    if (!channel || channel.readyState !== 'open') {
      return;
    }
    const heartbeatTimeoutMs = Math.max(
      this.config.disconnectedGracePeriodMs,
      this.config.heartbeatIntervalMs * 3,
    );
    if (
      session.lastSeenAt &&
      heartbeatTimeoutMs > 0 &&
      Date.now() - session.lastSeenAt > heartbeatTimeoutMs
    ) {
      session.failureCode = 'WEBRTC_HEARTBEAT_TIMEOUT';
      this.stats.connectionsFailed += 1;
      this.stats.lastError = session.failureCode;
      await this.closeSession(session.sessionId, 'failed');
      return;
    }
    const message = createNetworkMessage({
      messageType: 'peer.heartbeat',
      senderId: this.localPeerId,
      payload: {
        sessionId: session.sessionId,
        sentAt: Date.now(),
      },
      ttlMs: Math.max(30000, this.config.heartbeatIntervalMs * 3),
    });
    try {
      const serialized = JSON.stringify(message);
      channel.send(serialized);
      this.recordSent(serialized.length);
    } catch (error) {
      this.stats.lastError = error instanceof Error ? error.message : 'heartbeat-send-failed';
      this.logger.warn('heartbeat_send_failed', {
        peerId: session.peerId,
        sessionId: session.sessionId,
      });
    }
  }

  private scheduleDisconnectTimeout(session: InternalSession, failureCode: string): void {
    this.stopDisconnectTimer(session);
    if (this.config.disconnectedGracePeriodMs <= 0) {
      session.failureCode = failureCode;
      void this.closeSession(session.sessionId, 'failed');
      return;
    }
    session.disconnectTimer = globalThis.setTimeout(() => {
      session.disconnectTimer = null;
      if (session.closing || session.state !== 'disconnected') {
        return;
      }
      session.failureCode = failureCode;
      this.stats.connectionsFailed += 1;
      this.stats.lastError = failureCode;
      void this.closeSession(session.sessionId, 'failed');
    }, this.config.disconnectedGracePeriodMs);
  }

  private stopDisconnectTimer(session: InternalSession): void {
    if (!session.disconnectTimer) {
      return;
    }
    globalThis.clearTimeout(session.disconnectTimer);
    session.disconnectTimer = null;
  }

  private async waitForIceGathering(peerConnection: RTCPeerConnection): Promise<void> {
    if (peerConnection.iceGatheringState === 'complete') {
      return;
    }
    await new Promise<void>((resolve) => {
      const cleanup = () => {
        globalThis.clearTimeout(timeout);
        peerConnection.removeEventListener('icegatheringstatechange', handleStateChange);
      };
      const complete = () => {
        cleanup();
        resolve();
      };
      const handleStateChange = () => {
        if (peerConnection.iceGatheringState === 'complete') {
          complete();
        }
      };
      const timeout = globalThis.setTimeout(complete, this.config.connectionTimeoutMs);
      peerConnection.addEventListener('icegatheringstatechange', handleStateChange);
    });
  }

  private assertAvailable(): void {
    if (!this.isAvailable()) {
      throw this.createError(
        'RTCPeerConnection is not available in this environment',
        'availability',
      );
    }
  }

  private createError(message: string, operation: string): AppError {
    return new AppError({
      code: 'NETWORK_ERROR',
      message,
      safeMessage: getWebRtcSafeMessage(message, operation),
      severity: 'warning',
      retryable: operation !== 'availability',
      context: {
        scope: 'webrtc.peer.transport',
        operation,
      },
    });
  }

  recordSent(bytes: number): void {
    this.stats.messagesSent += 1;
    this.stats.bytesSent += bytes;
    this.stats.lastMessageAt = Date.now();
  }

  getOpenDataChannel(sessionId: string): RTCDataChannel | null {
    const channel = this.sessions.get(sessionId)?.dataChannel;
    return channel?.readyState === 'open' ? channel : null;
  }

  private isPeerChannelOpen(peerId: PeerId): boolean {
    const sessionId = this.sessionsByPeer.get(peerId);
    if (!sessionId) {
      return false;
    }
    return Boolean(this.getOpenDataChannel(sessionId));
  }

  getMaxBufferedAmount(): number {
    return this.config.maxBufferedAmount;
  }
}

function getWebRtcSafeMessage(message: string, operation: string): string {
  if (operation === 'availability') {
    return 'A conexao P2P WebRTC nao esta disponivel.';
  }
  if (message.includes('session not found')) {
    return 'Esta resposta nao pertence a uma oferta ativa neste navegador. Crie uma nova oferta e gere uma nova resposta.';
  }
  if (message.includes('Expected WebRTC answer')) {
    return 'Cole uma resposta WebRTC valida gerada pelo outro navegador.';
  }
  if (message.includes('Expected WebRTC offer')) {
    return 'Cole uma oferta WebRTC valida gerada pelo outro navegador.';
  }
  return 'A conexao P2P WebRTC falhou.';
}

function isPeerConnectionLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes('cannot create so many peerconnections') ||
    message.includes('too many peerconnections') ||
    message.includes('peerconnection limit')
  );
}

class WebRtcPeerConnection implements PeerConnection {
  lastSeenAt: number;

  constructor(
    private readonly transport: WebRtcPeerTransport,
    readonly peerId: PeerId,
    private readonly sessionId: string,
    readonly connectedAt: number,
  ) {
    this.lastSeenAt = connectedAt;
  }

  get localPeerId(): PeerId {
    return this.transport.localPeerId;
  }

  async send<TPayload>(
    messageType: NetworkMessage['messageType'],
    payload: TPayload,
    options: { correlationId?: string; ttlMs?: number } = {},
  ): Promise<void> {
    const message = createNetworkMessage({
      messageType,
      senderId: this.localPeerId,
      payload,
      correlationId: options.correlationId,
      ttlMs: options.ttlMs,
    });
    await this.transport.send(this.peerId, message);
  }

  async sendMessage(message: NetworkMessage): Promise<void> {
    const session = this.transport.getSessions().find((item) => item.sessionId === this.sessionId);
    if (!session) {
      throw new AppError({
        code: 'NETWORK_ERROR',
        message: 'WebRTC session not found',
        safeMessage: 'A sessao P2P nao foi encontrada.',
        severity: 'warning',
        retryable: true,
      });
    }
    const channel = this.transport.getOpenDataChannel(this.sessionId);
    if (!channel) {
      throw new AppError({
        code: 'NETWORK_ERROR',
        message: 'WebRTC data channel is not open',
        safeMessage: 'O canal P2P ainda nao esta aberto.',
        severity: 'warning',
        retryable: true,
      });
    }
    const serialized = JSON.stringify(message);
    if (serialized.length > MAX_NETWORK_MESSAGE_BYTES) {
      throw new AppError({
        code: 'NETWORK_ERROR',
        message: 'WebRTC message exceeds size limit',
        safeMessage: 'A mensagem P2P e grande demais.',
        severity: 'warning',
        retryable: false,
      });
    }
    if (channel.bufferedAmount > this.transport.getMaxBufferedAmount()) {
      throw new AppError({
        code: 'NETWORK_ERROR',
        message: 'WebRTC data channel backpressure limit exceeded',
        safeMessage: 'O canal P2P esta congestionado.',
        severity: 'warning',
        retryable: true,
      });
    }
    channel.send(serialized);
    this.lastSeenAt = Date.now();
    this.transport.recordSent(serialized.length);
  }
}
