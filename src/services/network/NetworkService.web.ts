import { AppError } from '@/errors/AppError';
import { NetworkEvents, type PeerOperationalState } from '@/network/NetworkEvents';
import type { NetworkConfig, PeerId } from '@/network/NetworkTypes';
import {
  createDefaultWebRtcAutoSignaling,
  encodePrivateNetworkInvite,
  type SynpeerPrivateNetworkSnapshot,
  type WebRtcAutoSignalingStatus,
  type WebRtcAutoSignalingTransport,
  type WebRtcAutoSignalMessage,
} from '@/network/WebRtcAutoSignaling';
import { decodeWebRtcSignal } from '@/network/WebRtcSignaling';
import {
  defaultWebRtcConfiguration,
  WebRtcPeerTransport,
  type WebRtcSessionState,
  type WebRtcSessionSnapshot,
  type WebRtcTransportStats,
} from '@/network/WebRtcPeerTransport';
import { createLogger } from '@/observability/Logger';
import { PeerHandshakeProtocol } from '@/services/peers/PeerHandshakeProtocol';
import {
  PeerSessionCoordinator,
  type CoordinatedPeerConnectResult,
  type IncomingOfferIgnoreReason,
  type PeerCoordinationSnapshot,
} from '@/services/peers/PeerSessionCoordinator';
import { PeerSessionService } from '@/services/peers/PeerSessionService';
import type { PeerTrustService } from '@/services/peers/PeerTrustService';
import type { TrustedPeerRepository } from '@/services/peers/TrustedPeerRepository';
import type { TrustedPeerSyncService } from '@/services/peers/TrustedPeerSyncService';
import { isWebRtcSignalAddress } from '@/services/peers/PeerAddress';
import { PeerIncrementalSyncProtocol } from '@/services/sync/PeerIncrementalSyncProtocol';
import type { IncrementalSyncService } from '@/services/sync/IncrementalSyncService';

export type NetworkLifecycleState =
  'idle' | 'initializing' | 'running' | 'stopping' | 'stopped' | 'error';

export interface NetworkServiceConfig {
  autoStart?: boolean;
  networkConfig?: NetworkConfig;
}

export type PeerConnectResult = CoordinatedPeerConnectResult;

export type PeerRuntimeSessionStatus = PeerOperationalState;

export interface PeerRuntimeSessionSnapshot {
  peerId: PeerId;
  status: PeerRuntimeSessionStatus;
  sessionId?: string;
  lastConnectedAt?: number;
  lastSeenAt?: number;
  lastDisconnectedAt?: number;
  reconnectAttempts: number;
  nextReconnectAt?: number;
  failureCode?: string;
}

type PeerProtocolConfiguration = {
  peerTrustService: PeerTrustService;
  trustedPeerRepository: TrustedPeerRepository;
  trustedPeerSyncService: TrustedPeerSyncService;
  incrementalSyncService: IncrementalSyncService | null;
};

const SYNC_RETRY_BASE_DELAY_MS = 5000;
const SYNC_RETRY_MAX_DELAY_MS = 60000;
const AUTO_SIGNAL_DEDUP_TTL_MS = 2 * 60 * 1000;

class WebPeerManager {
  constructor(private readonly getPeerIdValue: () => string | null) {}

  getPeerId(): string | null {
    return this.getPeerIdValue();
  }

  getListenAddresses(): string[] {
    return [];
  }

  getUptime(): number {
    return 0;
  }
}

class WebPeerConnectionFacade {
  constructor(
    private readonly getConnectedPeersValue: () => string[],
    private readonly getSessionsValue: () => WebRtcSessionSnapshot[],
  ) {}

  getConnectedPeers(): string[] {
    return this.getConnectedPeersValue();
  }

  getAllConnections(): Array<{ reconnectCount: number }> {
    return this.getSessionsValue().map((session) => ({ reconnectCount: session.retryCount }));
  }
}

class WebPeerDiscovery {
  getDiscoveredPeers(): string[] {
    return [];
  }
}

class WebPingProtocol {
  getAverageLatency(): number | null {
    return null;
  }
}

class WebIdentitySync {
  clearAllIdentities(): void {
    return undefined;
  }
}

class WebSyncProtocol {
  clearAllSyncResults(): void {
    return undefined;
  }
}

export class NetworkService {
  private readonly logger = createLogger('network.web');
  private readonly networkEvents = new NetworkEvents();
  private readonly peerDiscovery = new WebPeerDiscovery();
  private readonly pingProtocol = new WebPingProtocol();
  private readonly identitySync = new WebIdentitySync();
  private readonly syncProtocol = new WebSyncProtocol();
  private readonly peerManager = new WebPeerManager(() => this.localPeerId);
  private readonly peerConnection = new WebPeerConnectionFacade(
    () => this.getConnectedPeers(),
    () => this.getSessions(),
  );
  private localPeerId: PeerId | null = null;
  private state: NetworkLifecycleState = 'idle';
  private transport: WebRtcPeerTransport | null = null;
  private handshakeProtocol: PeerHandshakeProtocol | null = null;
  private incrementalSyncProtocol: PeerIncrementalSyncProtocol | null = null;
  private autoSignaling: WebRtcAutoSignalingTransport | null = null;
  private autoSignalingPeerId: PeerId | null = null;
  private sessionCoordinator: PeerSessionCoordinator | null = null;
  private unsubscribeSessionCoordinator: (() => void) | null = null;
  private unsubscribeAutoSignaling: (() => void) | null = null;
  private authenticatedPeers = new Set<PeerId>();
  private unsubscribeConnectionOpen: (() => void) | null = null;
  private unsubscribeSessionState: (() => void) | null = null;
  private protocolConfiguration: PeerProtocolConfiguration | null = null;
  private readonly peerSessions = new Map<PeerId, PeerRuntimeSessionSnapshot>();
  private readonly syncRetryTimers = new Map<PeerId, ReturnType<typeof globalThis.setTimeout>>();
  private readonly syncRetryAttempts = new Map<PeerId, number>();
  private readonly seenAutoSignals = new Map<string, number>();
  private readonly handshakesInFlight = new Set<PeerId>();
  private readonly incrementalSyncsInFlight = new Set<PeerId>();

  constructor(config: NetworkServiceConfig = {}) {
    void config;
  }

  setLocalPeerId(peerId: PeerId | null): void {
    const changedPeer = this.localPeerId !== peerId;
    if (changedPeer) {
      this.unsubscribeSessionCoordinator?.();
      this.unsubscribeSessionCoordinator = null;
      this.sessionCoordinator?.stop();
      this.sessionCoordinator = null;
    }
    this.localPeerId = peerId;
    if (peerId) {
      this.ensureSessionCoordinator();
    }
    this.configureAutoSignaling();
    if (changedPeer) {
      this.resetPeerProtocols();
    }
    if (!peerId && this.transport) {
      void this.transport.closeAll();
      this.transport = null;
    }
    if (peerId && (!this.transport || this.transport.localPeerId !== peerId)) {
      void this.transport?.closeAll();
      this.transport = new WebRtcPeerTransport(peerId, defaultWebRtcConfiguration);
      this.bindTransport();
      this.startPeerProtocols();
    }
  }

  configurePeerProtocols(configuration: PeerProtocolConfiguration): void {
    this.protocolConfiguration = configuration;
    this.resetPeerProtocols();
    this.startPeerProtocols();
  }

  async syncPeer(peerId: PeerId): Promise<number> {
    if (!this.incrementalSyncProtocol || !this.transport?.getConnection(peerId)) {
      throw new AppError({
        code: 'NETWORK_ERROR',
        message: `Peer ${peerId} is not ready for incremental sync`,
        safeMessage: 'O peer ainda nao esta pronto para sincronizar.',
        severity: 'warning',
        retryable: true,
        context: {
          scope: 'network.web',
          peerId,
        },
      });
    }
    this.updatePeerSession(peerId, {
      status: 'syncing',
      failureCode: null,
    });
    this.networkEvents.emit({
      category: 'sync',
      type: 'sync:started',
      peerId,
      syncType: 'data',
      timestamp: Date.now(),
    });
    try {
      const result = await this.incrementalSyncProtocol.syncPeer(peerId);
      this.updatePeerSession(peerId, {
        status: 'online',
        lastSeenAt: Date.now(),
        failureCode: null,
      });
      this.networkEvents.emit({
        category: 'sync',
        type: 'sync:finished',
        peerId,
        syncType: 'data',
        success: true,
        itemsSynced: result.applied,
        timestamp: Date.now(),
      });
      return result.applied;
    } catch (error) {
      this.updatePeerSession(peerId, {
        status: 'degraded',
        failureCode: 'PEER_INCREMENTAL_SYNC_FAILED',
      });
      this.networkEvents.emit({
        category: 'sync',
        type: 'sync:finished',
        peerId,
        syncType: 'data',
        success: false,
        timestamp: Date.now(),
      });
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.state === 'running') {
      return;
    }
    this.state = 'initializing';
    if (this.localPeerId) {
      this.ensureSessionCoordinator();
    }
    if (this.localPeerId && !this.transport) {
      this.transport = new WebRtcPeerTransport(this.localPeerId, defaultWebRtcConfiguration);
      this.bindTransport();
    }
    this.configureAutoSignaling();
    this.autoSignaling?.start();
    this.state = 'running';
    this.logger.info('network_started', {
      webrtcAvailable: this.isWebRtcAvailable(),
      autoSignalingAvailable: this.canAutoConnectToPeer(),
    });
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') {
      return;
    }
    this.state = 'stopping';
    this.clearSyncRetryTimers();
    this.handshakeProtocol?.stop();
    this.incrementalSyncProtocol?.stop();
    this.handshakeProtocol = null;
    this.incrementalSyncProtocol = null;
    this.unsubscribeConnectionOpen?.();
    this.unsubscribeConnectionOpen = null;
    this.unsubscribeSessionState?.();
    this.unsubscribeSessionState = null;
    this.unsubscribeAutoSignaling?.();
    this.unsubscribeAutoSignaling = null;
    this.autoSignaling?.stop();
    this.autoSignaling = null;
    this.autoSignalingPeerId = null;
    this.unsubscribeSessionCoordinator?.();
    this.unsubscribeSessionCoordinator = null;
    this.sessionCoordinator?.stop();
    this.sessionCoordinator = null;
    await this.transport?.closeAll();
    this.transport = null;
    this.authenticatedPeers.clear();
    this.peerSessions.clear();
    this.syncRetryAttempts.clear();
    this.seenAutoSignals.clear();
    this.handshakesInFlight.clear();
    this.incrementalSyncsInFlight.clear();
    this.state = 'stopped';
  }

  getState(): NetworkLifecycleState {
    return this.state;
  }

  async getLocalIdentity(): Promise<{
    peerId: PeerId;
    publicIdentity: string;
    createdAt: number;
  } | null> {
    if (!this.localPeerId) {
      return null;
    }
    return {
      peerId: this.localPeerId,
      publicIdentity: this.localPeerId,
      createdAt: 0,
    };
  }

  async createPeerOffer(peerId?: PeerId): Promise<string> {
    const transport = this.ensureTransport();
    return await transport.createOffer(peerId);
  }

  async acceptPeerOffer(offerCode: string): Promise<string> {
    const result = await this.processIncomingOffer(offerCode);
    if (!result.accepted) {
      throw this.createNegotiationError(
        `WebRTC offer ignored: ${result.reason}`,
        result.peerId,
        result.reason,
      );
    }
    return result.answerCode;
  }

  async applyPeerAnswer(answerCode: string): Promise<void> {
    const answer = decodeWebRtcSignal(answerCode);
    const transport = this.ensureTransport();
    const coordinator = this.ensureSessionCoordinator();
    const coordination = coordinator.getSnapshot(answer.peerId);
    if (coordination && !coordinator.canApplyAnswer(answer.peerId, answer.sessionId)) {
      throw this.createNegotiationError(
        'WebRTC answer does not match the current peer negotiation',
        answer.peerId,
        'stale-answer',
      );
    }
    await transport.applyAnswer(answerCode);
    coordinator.markAnswerApplied(answer.peerId, answer.sessionId);
  }

  async connectToPeer(peerId: PeerId): Promise<PeerConnectResult> {
    const coordinator = this.ensureSessionCoordinator();
    return await coordinator.coordinateConnect(peerId, async () => {
      if (this.transport?.getConnection(peerId)) {
        return { mode: 'auto-signaling' };
      }

      this.clearSyncRetryTimer(peerId);
      this.updatePeerSession(peerId, { status: 'connecting' });
      const offerCode = await this.createPeerOffer(peerId);
      const offer = decodeWebRtcSignal(offerCode);
      if (!coordinator.registerOutbound(peerId, offer.sessionId, offer.createdAt)) {
        await this.transport?.closeNegotiation(offer.sessionId);
        throw this.createNegotiationError(
          'WebRTC negotiation was cancelled before the offer was ready',
          peerId,
          'offer-cancelled',
        );
      }
      if (!this.canAutoConnectToPeer()) {
        return { mode: 'manual', offerCode };
      }

      await this.autoSignaling?.send('offer', peerId, offerCode);
      return { mode: 'auto-signaling' };
    });
  }

  async disconnectPeer(peerId: PeerId): Promise<void> {
    this.clearSyncRetryTimer(peerId);
    this.sessionCoordinator?.cancelPeer(peerId);
    this.authenticatedPeers.delete(peerId);
    this.syncRetryAttempts.delete(peerId);
    this.peerSessions.delete(peerId);
    await this.transport?.disconnect(peerId);
    this.protocolConfiguration?.trustedPeerRepository.updateSessionState(peerId, 'disconnected', {
      reason: 'removed-locally',
    });
    this.networkEvents.emit({
      category: 'peer',
      type: 'peer:disconnected',
      peerId,
      reason: 'removed-locally',
      timestamp: Date.now(),
    });
  }

  async resetPeerConnections(reason = 'manual-reset'): Promise<void> {
    this.clearSyncRetryTimers();
    this.authenticatedPeers.clear();
    this.peerSessions.clear();
    this.syncRetryAttempts.clear();
    this.seenAutoSignals.clear();
    this.handshakesInFlight.clear();
    this.incrementalSyncsInFlight.clear();
    this.unsubscribeSessionCoordinator?.();
    this.unsubscribeSessionCoordinator = null;
    this.sessionCoordinator?.stop();
    this.sessionCoordinator = null;
    if (this.localPeerId) {
      this.ensureSessionCoordinator();
    }
    this.resetPeerProtocols();
    await this.transport?.closeAll();
    this.transport = this.localPeerId
      ? new WebRtcPeerTransport(this.localPeerId, defaultWebRtcConfiguration)
      : null;
    this.bindTransport();
    this.logger.warn('peer_connections_reset', { reason });
  }

  getConnectedPeers(): string[] {
    return Array.from(this.authenticatedPeers);
  }

  getListenAddresses(): string[] {
    return this.peerManager.getListenAddresses();
  }

  canConnectToPeerAddress(): boolean {
    return this.isWebRtcAvailable();
  }

  canAutoReconnectToPeerAddress(): boolean {
    return this.canAutoConnectToPeer();
  }

  canAutoConnectToPeer(): boolean {
    return Boolean(this.autoSignaling?.isAvailable());
  }

  getAutoSignalingStatus(): WebRtcAutoSignalingStatus | null {
    return this.autoSignaling?.getStatus() ?? null;
  }

  async createPrivateNetwork(name = 'Synpeer Network', signalingUrl?: string): Promise<string> {
    if (!this.autoSignaling?.createPrivateNetwork) {
      throw new Error('Synpeer private network controller is not available.');
    }
    if (signalingUrl && this.autoSignaling.setSignalingServerUrl) {
      this.autoSignaling.setSignalingServerUrl(signalingUrl);
      this.autoSignaling.start();
    }
    const invite = await this.autoSignaling.createPrivateNetwork(name);
    return encodePrivateNetworkInvite(invite);
  }

  async joinPrivateNetwork(inviteCode: string): Promise<SynpeerPrivateNetworkSnapshot | null> {
    if (!this.autoSignaling?.joinPrivateNetwork) {
      throw new Error('Synpeer private network controller is not available.');
    }
    return await this.autoSignaling.joinPrivateNetwork(inviteCode);
  }

  async approvePrivateNetworkPeer(peerId: PeerId): Promise<void> {
    if (!this.autoSignaling?.approvePrivateNetworkPeer) {
      throw new Error('Synpeer private network controller is not available.');
    }
    await this.autoSignaling.approvePrivateNetworkPeer(peerId);
  }

  setSignalingServerUrl(url: string | null): void {
    this.autoSignaling?.setSignalingServerUrl?.(url);
    this.autoSignaling?.start();
  }

  getPrivateNetworkSnapshot(): SynpeerPrivateNetworkSnapshot | null {
    return this.autoSignaling?.getPrivateNetworkSnapshot?.() ?? null;
  }

  subscribePrivateNetwork(
    handler: (snapshot: SynpeerPrivateNetworkSnapshot | null) => void | Promise<void>,
  ): () => void {
    return this.autoSignaling?.subscribePrivateNetwork?.(handler) ?? (() => undefined);
  }

  restartAutoSignaling(): void {
    this.autoSignaling?.stop();
    this.autoSignaling?.start();
  }

  async connectToPeerAddress(signalingCode: string): Promise<void> {
    if (!isWebRtcSignalAddress(signalingCode)) {
      throw new Error('Manual WebRTC signaling code is required in the web runtime.');
    }
    await this.applyPeerAnswer(signalingCode);
  }

  getDiscoveredPeers(): string[] {
    return [];
  }

  getSessions(): WebRtcSessionSnapshot[] {
    return this.transport?.getSessions() ?? [];
  }

  getPeerRuntimeSessions(): PeerRuntimeSessionSnapshot[] {
    return Array.from(this.peerSessions.values()).sort((left, right) =>
      left.peerId.localeCompare(right.peerId),
    );
  }

  getPeerCoordinationSnapshots(): PeerCoordinationSnapshot[] {
    return this.sessionCoordinator?.getSnapshots() ?? [];
  }

  requestPeerReconnect(peerId: PeerId, reason = 'reconnect-requested', immediate = true): boolean {
    if (this.transport?.getConnection(peerId)) {
      return false;
    }
    return this.ensureSessionCoordinator().requestReconnect(peerId, reason, { immediate });
  }

  getTransportStats(): WebRtcTransportStats | null {
    return this.transport?.getStats() ?? null;
  }

  hasPendingPeerOffer(sessionId?: string): boolean {
    return this.transport?.hasPendingOutboundSession(sessionId) ?? false;
  }

  getNetworkEvents(): NetworkEvents {
    return this.networkEvents;
  }

  getPeerManager(): WebPeerManager {
    return this.peerManager;
  }

  getPeerDiscovery(): WebPeerDiscovery {
    return this.peerDiscovery;
  }

  getPeerConnection(): WebPeerConnectionFacade {
    return this.peerConnection;
  }

  getPingProtocol(): WebPingProtocol {
    return this.pingProtocol;
  }

  getIdentitySync(): WebIdentitySync {
    return this.identitySync;
  }

  getSyncProtocol(): WebSyncProtocol {
    return this.syncProtocol;
  }

  getPeerTransport(): WebRtcPeerTransport | null {
    return this.transport;
  }

  isRunning(): boolean {
    return this.state === 'running';
  }

  isWebRtcAvailable(): boolean {
    return typeof globalThis.RTCPeerConnection !== 'undefined';
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async cleanup(): Promise<void> {
    await this.stop();
    this.networkEvents.clearAllListeners();
  }

  private bindTransport(): void {
    this.unsubscribeConnectionOpen?.();
    this.unsubscribeSessionState?.();
    this.unsubscribeConnectionOpen =
      this.transport?.onConnectionOpen((peerId) => {
        this.updatePeerSession(peerId, { status: 'handshaking' });
        void this.authenticatePeer(peerId);
      }) ?? null;
    this.unsubscribeSessionState =
      this.transport?.onSessionStateChange((session) =>
        this.handleTransportSessionState(session),
      ) ?? null;
    this.startPeerProtocols();
  }

  private configureAutoSignaling(): void {
    if (!this.localPeerId) {
      this.unsubscribeAutoSignaling?.();
      this.unsubscribeAutoSignaling = null;
      this.autoSignaling?.stop();
      this.autoSignaling = null;
      this.autoSignalingPeerId = null;
      return;
    }

    if (this.autoSignaling && this.autoSignalingPeerId === this.localPeerId) {
      return;
    }

    this.unsubscribeAutoSignaling?.();
    this.autoSignaling?.stop();
    this.autoSignaling = createDefaultWebRtcAutoSignaling(this.localPeerId);
    this.autoSignalingPeerId = this.localPeerId;
    this.unsubscribeAutoSignaling = this.autoSignaling.subscribe((message) =>
      this.handleAutoSignal(message),
    );
    if (this.state === 'running') {
      this.autoSignaling.start();
    }
  }

  private async handleAutoSignal(message: WebRtcAutoSignalMessage): Promise<void> {
    this.pruneSeenAutoSignals();
    if (this.hasSeenAutoSignal(message.id)) {
      this.logger.debug('duplicate_auto_signal_ignored', {
        peerId: message.fromPeerId,
        signalType: message.type,
      });
      return;
    }
    try {
      const signal = decodeWebRtcSignal(message.code);
      if (signal.peerId !== message.fromPeerId || signal.type !== message.type) {
        this.markAutoSignalSeen(message.id);
        this.logger.warn('auto_signal_identity_mismatch', {
          peerId: message.fromPeerId,
          signalType: message.type,
        });
        return;
      }

      if (message.type === 'offer') {
        const result = await this.processIncomingOffer(message.code);
        if (!result.accepted) {
          this.markAutoSignalSeen(message.id);
          this.logger.info('auto_offer_ignored', {
            peerId: message.fromPeerId,
            sessionId: signal.sessionId,
            reason: result.reason,
          });
          if (result.reason === 'already-connected') {
            this.resumeHandshakeForOpenConnection(message.fromPeerId, 'duplicate-offer');
          }
          return;
        }
        await this.autoSignaling?.send('answer', message.fromPeerId, result.answerCode);
        this.markAutoSignalSeen(message.id);
        this.logger.info('auto_offer_accepted', {
          peerId: message.fromPeerId,
          sessionId: signal.sessionId,
        });
        return;
      }

      const coordinator = this.ensureSessionCoordinator();
      if (
        !coordinator.canApplyAnswer(message.fromPeerId, signal.sessionId) ||
        !this.hasPendingPeerOffer(signal.sessionId)
      ) {
        this.markAutoSignalSeen(message.id);
        this.logger.info('stale_auto_answer_ignored', {
          peerId: message.fromPeerId,
          sessionId: signal.sessionId,
        });
        return;
      }
      await this.applyPeerAnswer(message.code);
      this.markAutoSignalSeen(message.id);
      this.logger.info('auto_answer_applied', {
        peerId: message.fromPeerId,
        sessionId: signal.sessionId,
      });
    } catch (error) {
      if (message.type === 'offer' && isDuplicateConnectedOfferError(error)) {
        this.logger.warn('duplicate_connected_offer_ignored', {
          peerId: message.fromPeerId,
          message: error instanceof Error ? error.message : 'unknown',
        });
        this.resumeHandshakeForOpenConnection(message.fromPeerId, 'duplicate-offer');
        this.markAutoSignalSeen(message.id);
        return;
      }
      if (isPeerConnectionLimitError(error)) {
        await this.transport?.pruneStaleSessions();
        this.sessionCoordinator?.requestReconnect(message.fromPeerId, 'PEER_CONNECTION_LIMIT');
        this.logger.warn('auto_signal_peer_connection_limit_recovered', {
          peerId: message.fromPeerId,
          signalType: message.type,
          message: error instanceof Error ? error.message : 'unknown',
        });
        return;
      }
      if (message.type === 'answer' && isStaleWebRtcAnswerError(error)) {
        this.logger.warn('stale_auto_answer_ignored', {
          peerId: message.fromPeerId,
          message: error instanceof Error ? error.message : 'unknown',
        });
        this.markAutoSignalSeen(message.id);
        return;
      }
      this.logger.error('auto_signal_processing_failed', error, {
        peerId: message.fromPeerId,
        signalType: message.type,
      });
    }
  }

  private async processIncomingOffer(offerCode: string): Promise<
    | { accepted: true; answerCode: string; peerId: PeerId; sessionId: string }
    | {
        accepted: false;
        reason: IncomingOfferIgnoreReason;
        peerId: PeerId;
        sessionId: string;
      }
  > {
    const offer = decodeWebRtcSignal(offerCode);
    if (offer.type !== 'offer') {
      throw this.createNegotiationError(
        'Expected a WebRTC offer signaling payload',
        offer.peerId,
        'invalid-offer',
      );
    }

    const coordinator = this.ensureSessionCoordinator();
    const decision = coordinator.considerIncomingOffer(
      offer.peerId,
      offer.sessionId,
      offer.createdAt,
    );
    if (!decision.accepted) {
      return {
        accepted: false,
        reason: decision.reason,
        peerId: offer.peerId,
        sessionId: offer.sessionId,
      };
    }

    if (decision.replacedNegotiationId) {
      await this.transport?.closeNegotiation(decision.replacedNegotiationId);
    }
    try {
      const answerCode = await this.ensureTransport().acceptOffer(offerCode);
      return {
        accepted: true,
        answerCode,
        peerId: offer.peerId,
        sessionId: offer.sessionId,
      };
    } catch (error) {
      coordinator.handleTransportState(
        offer.peerId,
        offer.sessionId,
        'failed',
        error instanceof Error ? error.message : 'offer-accept-failed',
      );
      throw error;
    }
  }

  private startPeerProtocols(): void {
    if (!this.transport || !this.protocolConfiguration) {
      return;
    }
    const { peerTrustService, trustedPeerRepository, incrementalSyncService } =
      this.protocolConfiguration;
    if (!this.handshakeProtocol) {
      this.handshakeProtocol = new PeerHandshakeProtocol(
        this.transport,
        peerTrustService,
        new PeerSessionService(trustedPeerRepository),
        (peerId) => {
          this.markPeerAuthenticated(peerId);
        },
      );
      this.handshakeProtocol.start();
    }
    if (incrementalSyncService && !this.incrementalSyncProtocol) {
      this.incrementalSyncProtocol = new PeerIncrementalSyncProtocol(
        this.transport,
        incrementalSyncService,
        trustedPeerRepository,
        {
          onRefreshRequested: (peerId) => {
            this.runIncrementalSync(peerId, 'remote-change-hint');
          },
        },
      );
      this.incrementalSyncProtocol.start();
    }
  }

  private resetPeerProtocols(): void {
    this.handshakeProtocol?.stop();
    this.incrementalSyncProtocol?.stop();
    this.handshakeProtocol = null;
    this.incrementalSyncProtocol = null;
    this.authenticatedPeers.clear();
    this.peerSessions.clear();
    this.seenAutoSignals.clear();
    this.syncRetryAttempts.clear();
    this.clearSyncRetryTimers();
    this.handshakesInFlight.clear();
    this.incrementalSyncsInFlight.clear();
  }

  private async authenticatePeer(peerId: PeerId): Promise<void> {
    if (this.authenticatedPeers.has(peerId)) {
      return;
    }
    if (this.handshakesInFlight.has(peerId)) {
      this.logger.debug('peer_handshake_already_in_progress', { peerId });
      return;
    }
    if (!this.handshakeProtocol) {
      this.logger.warn('handshake_protocol_not_ready', { peerId });
      return;
    }
    if (!this.transport?.getConnection(peerId)) {
      this.updatePeerSession(peerId, {
        status: 'reconnecting',
        failureCode: 'PEER_HANDSHAKE_CONNECTION_MISSING',
      });
      this.protocolConfiguration?.trustedPeerRepository.updateSessionState(peerId, 'disconnected', {
        reason: 'handshake-connection-missing',
      });
      this.logger.warn('peer_handshake_deferred_until_reconnect', { peerId });
      this.schedulePeerReconnect(peerId, 'handshake-connection-missing');
      return;
    }
    this.handshakesInFlight.add(peerId);
    try {
      const verified = await this.handshakeProtocol.handshake(peerId);
      if (verified) {
        this.markPeerAuthenticated(peerId);
        return;
      }
      this.updatePeerSession(peerId, {
        status: 'degraded',
        failureCode: 'PEER_HANDSHAKE_NOT_VERIFIED',
      });
      this.protocolConfiguration?.trustedPeerRepository.updateSessionState(peerId, 'failed', {
        reason: 'handshake-not-verified',
      });
    } catch (error) {
      if (isTransientHandshakeFailure(error)) {
        this.updatePeerSession(peerId, {
          status: 'reconnecting',
          failureCode: 'PEER_HANDSHAKE_TRANSIENT_FAILURE',
        });
        this.protocolConfiguration?.trustedPeerRepository.updateSessionState(
          peerId,
          'disconnected',
          { reason: error instanceof Error ? error.message : 'handshake-transient-failure' },
        );
        this.logger.warn('peer_handshake_retry_scheduled', {
          peerId,
          message: error instanceof Error ? error.message : 'unknown',
        });
        this.schedulePeerReconnect(peerId, 'handshake-transient-failure');
        return;
      }
      this.updatePeerSession(peerId, {
        status: 'degraded',
        failureCode: 'PEER_HANDSHAKE_FAILED',
      });
      this.protocolConfiguration?.trustedPeerRepository.updateSessionState(peerId, 'failed', {
        reason: error instanceof Error ? error.message : 'handshake-failed',
      });
      this.logger.error('peer_handshake_failed', error, { peerId });
      this.networkEvents.emit({
        category: 'error',
        type: 'network:error',
        error: error instanceof Error ? error.message : 'Peer handshake failed',
        peerId,
        context: 'handshake',
        timestamp: Date.now(),
      });
    } finally {
      this.handshakesInFlight.delete(peerId);
    }
  }

  private resumeHandshakeForOpenConnection(peerId: PeerId, reason: string): void {
    if (this.authenticatedPeers.has(peerId) || !this.transport?.getConnection(peerId)) {
      return;
    }
    this.updatePeerSession(peerId, {
      status: 'handshaking',
      failureCode: null,
      lastSeenAt: Date.now(),
    });
    this.protocolConfiguration?.trustedPeerRepository.updateSessionState(peerId, 'connecting', {
      reason,
    });
    void this.authenticatePeer(peerId);
  }

  private markPeerAuthenticated(peerId: PeerId): void {
    if (this.authenticatedPeers.has(peerId)) {
      return;
    }
    this.authenticatedPeers.add(peerId);
    this.clearSyncRetryTimer(peerId);
    this.syncRetryAttempts.set(peerId, 0);
    this.transport?.markAuthenticated(peerId);
    this.protocolConfiguration?.trustedPeerRepository.recordConnection(peerId);
    this.protocolConfiguration?.trustedPeerRepository.updateSessionState(peerId, 'verified');
    this.updatePeerSession(peerId, {
      status: this.incrementalSyncProtocol ? 'syncing' : 'online',
      lastConnectedAt: Date.now(),
      lastSeenAt: Date.now(),
      nextReconnectAt: null,
      failureCode: null,
    });
    this.networkEvents.emit({
      category: 'peer',
      type: 'peer:connected',
      peerId,
      timestamp: Date.now(),
    });
    this.runIncrementalSync(peerId, 'peer-authenticated');
  }

  private handleTransportSessionState(session: WebRtcSessionSnapshot): void {
    if (session.peerId === this.localPeerId) {
      return;
    }
    this.sessionCoordinator?.handleTransportState(
      session.peerId,
      session.sessionId,
      session.state,
      session.failureCode,
    );
    if (
      session.state === 'created' ||
      session.state === 'signaling' ||
      session.state === 'connecting'
    ) {
      this.updatePeerSession(session.peerId, {
        status: 'connecting',
        sessionId: session.sessionId,
        failureCode: session.failureCode,
      });
      this.protocolConfiguration?.trustedPeerRepository.updateSessionState(
        session.peerId,
        'connecting',
        { sessionId: session.sessionId },
      );
      return;
    }
    if (session.state === 'connected') {
      this.updatePeerSession(session.peerId, {
        status: 'handshaking',
        sessionId: session.sessionId,
        lastConnectedAt: session.connectedAt,
        lastSeenAt: session.lastSeenAt,
      });
      return;
    }
    if (session.state === 'authenticated') {
      this.updatePeerSession(session.peerId, {
        status: 'online',
        sessionId: session.sessionId,
        lastConnectedAt: session.connectedAt,
        lastSeenAt: session.lastSeenAt,
      });
      return;
    }
    this.handlePeerSessionClosed(session.peerId, session.state, session);
  }

  private handlePeerSessionClosed(
    peerId: PeerId,
    state: Extract<WebRtcSessionState, 'disconnected' | 'failed' | 'closed'>,
    session: WebRtcSessionSnapshot,
  ): void {
    const wasAuthenticated = this.authenticatedPeers.delete(peerId);
    this.protocolConfiguration?.trustedPeerRepository.updateSessionState(
      peerId,
      state === 'failed' ? 'failed' : 'disconnected',
      {
        sessionId: session.sessionId,
        reason: session.failureCode ?? state,
      },
    );
    if (wasAuthenticated) {
      this.networkEvents.emit({
        category: 'peer',
        type: 'peer:disconnected',
        peerId,
        reason: session.failureCode ?? state,
        timestamp: Date.now(),
      });
    }
    this.updatePeerSession(peerId, {
      status: state !== 'disconnected' && this.canAutoConnectToPeer() ? 'reconnecting' : 'offline',
      sessionId: session.sessionId,
      lastDisconnectedAt: session.disconnectedAt ?? Date.now(),
      failureCode: session.failureCode ?? state,
    });
    this.clearSyncRetryTimer(peerId);
  }

  private runIncrementalSync(peerId: PeerId, reason: string): void {
    if (!this.incrementalSyncProtocol) {
      this.updatePeerSession(peerId, { status: 'online', lastSeenAt: Date.now() });
      return;
    }
    if (this.incrementalSyncsInFlight.has(peerId)) {
      this.logger.debug('peer_incremental_sync_already_in_progress', { peerId, reason });
      return;
    }
    if (!this.transport?.getConnection(peerId)) {
      this.scheduleIncrementalSyncRetry(peerId, 'missing-connection');
      return;
    }
    this.clearSyncRetryTimer(peerId);
    this.incrementalSyncsInFlight.add(peerId);
    this.updatePeerSession(peerId, { status: 'syncing', failureCode: null });
    void this.syncPeer(peerId)
      .then((applied) => {
        this.syncRetryAttempts.set(peerId, 0);
        this.updatePeerSession(peerId, {
          status: 'online',
          lastSeenAt: Date.now(),
          failureCode: null,
        });
        if (applied > 0) {
          this.notifyPeersOfSynchronizedChanges(peerId);
        }
      })
      .catch((error) => {
        this.updatePeerSession(peerId, {
          status: 'degraded',
          failureCode: 'PEER_INCREMENTAL_SYNC_FAILED',
        });
        this.logger.warn('peer_incremental_sync_failed', {
          peerId,
          reason,
          message: error instanceof Error ? error.message : 'unknown',
        });
        if (isRetryableIncrementalSyncFailure(error)) {
          this.scheduleIncrementalSyncRetry(peerId, 'sync-failed');
        } else {
          this.clearSyncRetryTimer(peerId);
          this.syncRetryAttempts.delete(peerId);
          this.logger.warn('peer_incremental_sync_rejected', {
            peerId,
            reason: 'non-retryable-validation-error',
            errorCode: error instanceof AppError ? error.code : undefined,
          });
        }
      })
      .finally(() => {
        this.incrementalSyncsInFlight.delete(peerId);
      });
  }

  private notifyPeersOfSynchronizedChanges(sourcePeerId: PeerId): void {
    if (!this.incrementalSyncProtocol) {
      return;
    }
    for (const peerId of this.authenticatedPeers) {
      if (peerId === sourcePeerId || !this.transport?.getConnection(peerId)) {
        continue;
      }
      void this.incrementalSyncProtocol.notifyPeerOfChanges(peerId).catch((error) => {
        this.logger.warn('peer_sync_hint_failed', {
          peerId,
          sourcePeerId,
          message: error instanceof Error ? error.message : 'unknown',
        });
      });
    }
  }

  private scheduleIncrementalSyncRetry(peerId: PeerId, reason: string): void {
    if (this.state !== 'running' || !this.transport?.getConnection(peerId)) {
      return;
    }
    if (this.syncRetryTimers.has(peerId)) {
      return;
    }
    const attempts = (this.syncRetryAttempts.get(peerId) ?? 0) + 1;
    const delayMs = Math.min(
      SYNC_RETRY_MAX_DELAY_MS,
      SYNC_RETRY_BASE_DELAY_MS * 2 ** Math.min(attempts - 1, 5),
    );
    this.syncRetryAttempts.set(peerId, attempts);
    const timer = globalThis.setTimeout(() => {
      this.syncRetryTimers.delete(peerId);
      this.runIncrementalSync(peerId, reason);
    }, delayMs);
    this.syncRetryTimers.set(peerId, timer);
    this.logger.warn('peer_incremental_sync_retry_scheduled', {
      peerId,
      reason,
      attempts,
      delayMs,
    });
  }

  private schedulePeerReconnect(peerId: PeerId, reason: string): void {
    this.ensureSessionCoordinator().requestReconnect(peerId, reason);
  }

  private hasSeenAutoSignal(messageId: string): boolean {
    return this.seenAutoSignals.has(messageId);
  }

  private markAutoSignalSeen(messageId: string): void {
    this.seenAutoSignals.set(messageId, Date.now());
  }

  private pruneSeenAutoSignals(now = Date.now()): void {
    for (const [messageId, seenAt] of this.seenAutoSignals.entries()) {
      if (now - seenAt > AUTO_SIGNAL_DEDUP_TTL_MS) {
        this.seenAutoSignals.delete(messageId);
      }
    }
  }

  private updatePeerSession(
    peerId: PeerId,
    patch: Partial<
      Omit<PeerRuntimeSessionSnapshot, 'peerId' | 'nextReconnectAt' | 'failureCode'>
    > & {
      nextReconnectAt?: number | null;
      failureCode?: string | null;
    },
  ): void {
    const existing = this.peerSessions.get(peerId);
    const next: PeerRuntimeSessionSnapshot = {
      peerId,
      status: patch.status ?? existing?.status ?? 'offline',
      sessionId: patch.sessionId ?? existing?.sessionId,
      lastConnectedAt: patch.lastConnectedAt ?? existing?.lastConnectedAt,
      lastSeenAt: patch.lastSeenAt ?? existing?.lastSeenAt,
      lastDisconnectedAt: patch.lastDisconnectedAt ?? existing?.lastDisconnectedAt,
      reconnectAttempts: patch.reconnectAttempts ?? existing?.reconnectAttempts ?? 0,
      nextReconnectAt:
        patch.nextReconnectAt === null
          ? undefined
          : (patch.nextReconnectAt ?? existing?.nextReconnectAt),
      failureCode:
        patch.failureCode === null ? undefined : (patch.failureCode ?? existing?.failureCode),
    };
    this.peerSessions.set(peerId, next);
    if (hasPeerSessionChanged(existing, next)) {
      this.networkEvents.emit({
        category: 'peer',
        type: 'peer:state-changed',
        peerId,
        state: next.status,
        previousState: existing?.status,
        failureCode: next.failureCode,
        reconnectAttempts: next.reconnectAttempts,
        nextReconnectAt: next.nextReconnectAt,
        timestamp: Date.now(),
      });
    }
  }

  private clearSyncRetryTimers(): void {
    for (const timer of this.syncRetryTimers.values()) {
      globalThis.clearTimeout(timer);
    }
    this.syncRetryTimers.clear();
  }

  private clearSyncRetryTimer(peerId: PeerId): void {
    const timer = this.syncRetryTimers.get(peerId);
    if (!timer) {
      return;
    }
    globalThis.clearTimeout(timer);
    this.syncRetryTimers.delete(peerId);
  }

  private ensureSessionCoordinator(): PeerSessionCoordinator {
    if (!this.localPeerId) {
      throw this.createNegotiationError(
        'Local identity is required before coordinating WebRTC sessions',
        'unknown',
        'identity-required',
      );
    }
    if (!this.sessionCoordinator) {
      this.sessionCoordinator = new PeerSessionCoordinator(
        this.localPeerId,
        { now: () => Date.now() },
        {
          canReconnect: (peerId) => this.canReconnectPeer(peerId),
          onReconnect: async (peerId) => {
            this.logger.info('peer_reconnect_attempt_started', { peerId });
            await this.connectToPeer(peerId);
          },
          onNegotiationTimeout: async (peerId, negotiationId) => {
            await this.transport?.closeNegotiation(negotiationId);
            this.protocolConfiguration?.trustedPeerRepository.updateSessionState(
              peerId,
              'disconnected',
              {
                sessionId: negotiationId,
                reason: 'negotiation-timeout',
              },
            );
          },
        },
      );
      this.unsubscribeSessionCoordinator = this.sessionCoordinator.subscribe((snapshot) => {
        this.handleCoordinatorSnapshot(snapshot);
      });
    }
    return this.sessionCoordinator;
  }

  private canReconnectPeer(peerId: PeerId): boolean {
    if (this.state !== 'running' || !this.canAutoConnectToPeer()) {
      return false;
    }
    const peer = this.protocolConfiguration?.trustedPeerRepository.get(peerId);
    return Boolean(
      peer &&
      peer.trustStatus === 'verified' &&
      peer.sessionState !== 'blocked' &&
      !this.protocolConfiguration?.trustedPeerRepository.isRemoved(peerId),
    );
  }

  private handleCoordinatorSnapshot(snapshot: PeerCoordinationSnapshot): void {
    const existing = this.peerSessions.get(snapshot.peerId);
    const status: PeerRuntimeSessionStatus =
      snapshot.status === 'reconnecting'
        ? 'reconnecting'
        : snapshot.status === 'failed'
          ? 'degraded'
          : snapshot.status === 'disconnected'
            ? 'offline'
            : snapshot.status === 'connected'
              ? (existing?.status ?? 'handshaking')
              : 'connecting';
    this.updatePeerSession(snapshot.peerId, {
      status,
      sessionId: snapshot.negotiationId,
      lastDisconnectedAt: snapshot.lastDisconnectedAt,
      reconnectAttempts: snapshot.reconnectAttempts,
      nextReconnectAt: snapshot.nextReconnectAt ?? null,
      failureCode: snapshot.failureCode ?? null,
    });
  }

  private ensureTransport(): WebRtcPeerTransport {
    if (!this.localPeerId) {
      throw new Error('Local identity is required before creating WebRTC signaling.');
    }
    if (!this.transport) {
      this.transport = new WebRtcPeerTransport(this.localPeerId, defaultWebRtcConfiguration);
      this.bindTransport();
    }
    return this.transport;
  }

  private createNegotiationError(message: string, peerId: PeerId, operation: string): AppError {
    return new AppError({
      code: 'NETWORK_ERROR',
      message,
      safeMessage: 'A negociacao P2P foi substituida ou nao esta mais ativa.',
      severity: 'warning',
      retryable: true,
      context: {
        scope: 'network.web.session-coordinator',
        operation,
        peerId,
      },
    });
  }
}

function hasPeerSessionChanged(
  previous: PeerRuntimeSessionSnapshot | undefined,
  next: PeerRuntimeSessionSnapshot,
): boolean {
  return (
    !previous ||
    previous.status !== next.status ||
    previous.sessionId !== next.sessionId ||
    previous.reconnectAttempts !== next.reconnectAttempts ||
    previous.nextReconnectAt !== next.nextReconnectAt ||
    previous.failureCode !== next.failureCode
  );
}

function isTransientHandshakeFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes('not connected') ||
    message.includes('data channel') ||
    message.includes('session not found') ||
    message.includes('handshake timed out')
  );
}

function isStaleWebRtcAnswerError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes('wrong state: stable') ||
    (message.includes('setremotedescription') && message.includes('stable'))
  );
}

function isPeerConnectionLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes('cannot create so many peerconnections') ||
    message.includes('too many peerconnections') ||
    message.includes('peerconnection limit') ||
    message.includes('peer connection limit')
  );
}

function isDuplicateConnectedOfferError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes('Peer already has an open WebRTC session')
  );
}

function isRetryableIncrementalSyncFailure(error: unknown): boolean {
  return !(error instanceof AppError) || error.retryable;
}

export function getNetworkService(): NetworkService {
  return (networkServiceInstance ??= new NetworkService());
}

export function resetNetworkService(): void {
  networkServiceInstance = null;
}

let networkServiceInstance: NetworkService | null = null;
