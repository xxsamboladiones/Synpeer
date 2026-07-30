import { AppError } from '@/errors/AppError';
import type { PeerId } from '@/network/NetworkTypes';
import type { WebRtcSessionState } from '@/network/WebRtcPeerTransport';

import {
  calculateReconnectDelay,
  classifyPeerFailure,
  defaultPeerReconnectPolicy,
  isRetryablePeerFailure,
  type PeerFailureKind,
  type PeerReconnectPolicy,
} from './PeerReconnectPolicy';

export type CoordinatedPeerConnectResult =
  { mode: 'auto-signaling' } | { mode: 'manual'; offerCode: string };

export type PeerCoordinationStatus =
  'negotiating' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

export interface PeerCoordinationSnapshot {
  peerId: PeerId;
  direction: 'inbound' | 'outbound';
  status: PeerCoordinationStatus;
  negotiationId?: string;
  startedAt: number;
  signalCreatedAt?: number;
  updatedAt: number;
  reconnectAttempts: number;
  nextReconnectAt?: number;
  lastDisconnectedAt?: number;
  failureCode?: string;
  failureKind?: PeerFailureKind;
}

export type IncomingOfferIgnoreReason =
  | 'already-connected'
  | 'coordinator-stopped'
  | 'duplicate-offer'
  | 'glare-local-wins'
  | 'stale-offer';

export type IncomingOfferDecision =
  | {
      accepted: true;
      replacedNegotiationId?: string;
    }
  | {
      accepted: false;
      reason: IncomingOfferIgnoreReason;
    };

export interface PeerSessionCoordinatorClock {
  now(): number;
}

export interface PeerSessionCoordinatorScheduler {
  setTimeout(handler: () => void, delayMs: number): ReturnType<typeof globalThis.setTimeout>;
  clearTimeout(timer: ReturnType<typeof globalThis.setTimeout>): void;
}

export interface PeerSessionCoordinatorOptions {
  reconnectPolicy?: Partial<PeerReconnectPolicy>;
  scheduler?: PeerSessionCoordinatorScheduler;
  canReconnect?: (peerId: PeerId, failureKind: PeerFailureKind) => boolean;
  onReconnect?: (peerId: PeerId) => Promise<void>;
  onNegotiationTimeout?: (peerId: PeerId, negotiationId: string) => void | Promise<void>;
}

type RetryWindow = {
  startedAt: number;
  attempts: number;
};

export class PeerSessionCoordinator {
  private readonly sessions = new Map<PeerId, PeerCoordinationSnapshot>();
  private readonly connectOperations = new Map<PeerId, Promise<CoordinatedPeerConnectResult>>();
  private readonly reconnectTimers = new Map<PeerId, ReturnType<typeof globalThis.setTimeout>>();
  private readonly negotiationTimers = new Map<PeerId, ReturnType<typeof globalThis.setTimeout>>();
  private readonly retryWindows = new Map<PeerId, RetryWindow>();
  private readonly listeners = new Set<(snapshot: PeerCoordinationSnapshot) => void>();
  private readonly policy: PeerReconnectPolicy;
  private readonly scheduler: PeerSessionCoordinatorScheduler;
  private stopped = false;

  constructor(
    private readonly localPeerId: PeerId,
    private readonly clock: PeerSessionCoordinatorClock = { now: () => Date.now() },
    private readonly options: PeerSessionCoordinatorOptions = {},
  ) {
    this.policy = {
      ...defaultPeerReconnectPolicy,
      ...options.reconnectPolicy,
    };
    this.scheduler = options.scheduler ?? {
      setTimeout: (handler, delayMs) => globalThis.setTimeout(handler, delayMs),
      clearTimeout: (timer) => globalThis.clearTimeout(timer),
    };
  }

  coordinateConnect(
    peerId: PeerId,
    operation: () => Promise<CoordinatedPeerConnectResult>,
  ): Promise<CoordinatedPeerConnectResult> {
    this.assertRunning();
    this.expireStaleNegotiation(peerId);

    const existingOperation = this.connectOperations.get(peerId);
    if (existingOperation) {
      return existingOperation;
    }

    const active = this.sessions.get(peerId);
    if (
      active?.status === 'connected' ||
      active?.status === 'negotiating' ||
      active?.status === 'connecting'
    ) {
      return Promise.resolve({ mode: 'auto-signaling' });
    }

    this.clearReconnectTimer(peerId);
    const now = this.clock.now();
    this.setSnapshot({
      peerId,
      direction: 'outbound',
      status: 'negotiating',
      startedAt: now,
      updatedAt: now,
      reconnectAttempts: this.retryWindows.get(peerId)?.attempts ?? 0,
    });

    const coordinatedOperation = operation().catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : 'peer-negotiation-failed';
      this.markFailed(peerId, reason);
      if (this.connectOperations.get(peerId) === coordinatedOperation) {
        this.connectOperations.delete(peerId);
      }
      this.requestReconnect(peerId, reason);
      throw error;
    });
    this.connectOperations.set(peerId, coordinatedOperation);
    return coordinatedOperation;
  }

  registerOutbound(peerId: PeerId, negotiationId: string, signalCreatedAt?: number): boolean {
    if (this.stopped) {
      return false;
    }
    const current = this.sessions.get(peerId);
    if (!current || current.direction !== 'outbound' || current.status !== 'negotiating') {
      return false;
    }
    this.setSnapshot({
      ...current,
      negotiationId,
      signalCreatedAt: signalCreatedAt ?? current.signalCreatedAt ?? current.startedAt,
      updatedAt: this.clock.now(),
    });
    this.scheduleNegotiationTimeout(peerId, negotiationId);
    return true;
  }

  considerIncomingOffer(
    peerId: PeerId,
    negotiationId: string,
    createdAt: number,
  ): IncomingOfferDecision {
    if (this.stopped) {
      return { accepted: false, reason: 'coordinator-stopped' };
    }

    const current = this.sessions.get(peerId);
    if (current?.status === 'connected') {
      return { accepted: false, reason: 'already-connected' };
    }
    if (current?.direction === 'inbound' && current.negotiationId === negotiationId) {
      return { accepted: false, reason: 'duplicate-offer' };
    }
    if (current?.direction === 'outbound') {
      const currentSignalCreatedAt = current.signalCreatedAt ?? current.startedAt;
      if (createdAt < currentSignalCreatedAt - this.policy.glareWindowMs) {
        return { accepted: false, reason: 'stale-offer' };
      }
      const offersAreConcurrent =
        Math.abs(createdAt - currentSignalCreatedAt) <= this.policy.glareWindowMs;
      if (offersAreConcurrent && this.localPeerId.localeCompare(peerId) < 0) {
        return { accepted: false, reason: 'glare-local-wins' };
      }
    }
    if (
      current?.direction === 'inbound' &&
      current.negotiationId &&
      createdAt <= (current.signalCreatedAt ?? current.startedAt)
    ) {
      return { accepted: false, reason: 'stale-offer' };
    }

    const replacedNegotiationId = current?.negotiationId;
    this.clearNegotiationTimer(peerId);
    if (current?.direction === 'outbound') {
      this.connectOperations.delete(peerId);
    }
    const now = this.clock.now();
    this.setSnapshot({
      peerId,
      direction: 'inbound',
      status: 'negotiating',
      negotiationId,
      startedAt: now,
      signalCreatedAt: createdAt,
      updatedAt: now,
      reconnectAttempts: this.retryWindows.get(peerId)?.attempts ?? 0,
    });
    this.scheduleNegotiationTimeout(peerId, negotiationId);
    return {
      accepted: true,
      replacedNegotiationId:
        replacedNegotiationId === negotiationId ? undefined : replacedNegotiationId,
    };
  }

  canApplyAnswer(peerId: PeerId, negotiationId: string): boolean {
    const current = this.sessions.get(peerId);
    return Boolean(
      !this.stopped &&
      current?.direction === 'outbound' &&
      current.negotiationId === negotiationId &&
      (current.status === 'negotiating' || current.status === 'connecting'),
    );
  }

  markAnswerApplied(peerId: PeerId, negotiationId: string): void {
    const current = this.sessions.get(peerId);
    if (!current || current.direction !== 'outbound' || current.negotiationId !== negotiationId) {
      return;
    }
    this.setSnapshot({
      ...current,
      status: 'connecting',
      updatedAt: this.clock.now(),
    });
  }

  handleTransportState(
    peerId: PeerId,
    negotiationId: string,
    state: WebRtcSessionState,
    failureCode?: string,
  ): void {
    if (this.stopped) {
      return;
    }
    const current = this.sessions.get(peerId);
    if (!current || (current.negotiationId && current.negotiationId !== negotiationId)) {
      return;
    }

    const status = mapTransportState(state);
    const now = this.clock.now();
    if (status === 'connected') {
      this.connectOperations.delete(peerId);
      this.clearNegotiationTimer(peerId);
      this.clearReconnectTimer(peerId);
      this.retryWindows.delete(peerId);
    }
    if (status === 'disconnected' || status === 'failed') {
      this.connectOperations.delete(peerId);
      this.clearNegotiationTimer(peerId);
    }
    this.setSnapshot({
      ...current,
      negotiationId,
      status,
      updatedAt: now,
      reconnectAttempts:
        status === 'connected' ? 0 : (this.retryWindows.get(peerId)?.attempts ?? 0),
      nextReconnectAt: status === 'connected' ? undefined : current.nextReconnectAt,
      lastDisconnectedAt:
        status === 'disconnected' || status === 'failed' ? now : current.lastDisconnectedAt,
      failureCode,
      failureKind: failureCode ? classifyPeerFailure(failureCode) : current.failureKind,
    });

    if (state === 'closed' || state === 'failed') {
      this.requestReconnect(peerId, failureCode ?? state);
    }
  }

  requestReconnect(
    peerId: PeerId,
    reason: string,
    options: { immediate?: boolean; minimumDelayMs?: number } = {},
  ): boolean {
    if (this.stopped || this.reconnectTimers.has(peerId)) {
      return false;
    }
    const failureKind = classifyPeerFailure(reason);
    if (
      !isRetryablePeerFailure(failureKind) ||
      this.options.canReconnect?.(peerId, failureKind) === false ||
      !this.options.onReconnect
    ) {
      return false;
    }
    if (this.sessions.get(peerId)?.status === 'connected') {
      return false;
    }

    const now = this.clock.now();
    const existingWindow = this.retryWindows.get(peerId);
    const window =
      !existingWindow || now - existingWindow.startedAt >= this.policy.attemptWindowMs
        ? { startedAt: now, attempts: 0 }
        : existingWindow;
    const windowExhausted = window.attempts >= this.policy.maxAttemptsPerWindow;
    const attempts = windowExhausted ? window.attempts : window.attempts + 1;
    this.retryWindows.set(peerId, { ...window, attempts });

    const delayMs = windowExhausted
      ? Math.max(0, window.startedAt + this.policy.attemptWindowMs - now)
      : options.immediate
        ? 0
        : calculateReconnectDelay({
            localPeerId: this.localPeerId,
            remotePeerId: peerId,
            attempt: attempts,
            policy: this.policy,
            minimumDelayMs:
              failureKind === 'transport-limit'
                ? Math.max(options.minimumDelayMs ?? 0, this.policy.transportLimitDelayMs)
                : options.minimumDelayMs,
          });
    const nextReconnectAt = now + delayMs;
    const current = this.sessions.get(peerId);
    this.setSnapshot({
      peerId,
      direction: current?.direction ?? 'outbound',
      status: 'reconnecting',
      negotiationId: current?.negotiationId,
      startedAt: current?.startedAt ?? now,
      signalCreatedAt: current?.signalCreatedAt,
      updatedAt: now,
      reconnectAttempts: attempts,
      nextReconnectAt,
      lastDisconnectedAt: current?.lastDisconnectedAt ?? now,
      failureCode: reason,
      failureKind,
    });

    const timer = this.scheduler.setTimeout(() => {
      this.reconnectTimers.delete(peerId);
      if (windowExhausted) {
        this.retryWindows.delete(peerId);
      }
      void this.runReconnect(peerId, reason);
    }, delayMs);
    this.reconnectTimers.set(peerId, timer);
    return true;
  }

  cancelPeer(peerId: PeerId): void {
    this.clearNegotiationTimer(peerId);
    this.clearReconnectTimer(peerId);
    this.sessions.delete(peerId);
    this.connectOperations.delete(peerId);
    this.retryWindows.delete(peerId);
  }

  subscribe(listener: (snapshot: PeerCoordinationSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(peerId: PeerId): PeerCoordinationSnapshot | null {
    const snapshot = this.sessions.get(peerId);
    return snapshot ? { ...snapshot } : null;
  }

  getSnapshots(): PeerCoordinationSnapshot[] {
    return Array.from(this.sessions.values(), (snapshot) => ({ ...snapshot })).sort((left, right) =>
      left.peerId.localeCompare(right.peerId),
    );
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.reconnectTimers.values()) {
      this.scheduler.clearTimeout(timer);
    }
    for (const timer of this.negotiationTimers.values()) {
      this.scheduler.clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    this.negotiationTimers.clear();
    this.sessions.clear();
    this.connectOperations.clear();
    this.retryWindows.clear();
    this.listeners.clear();
  }

  private expireStaleNegotiation(peerId: PeerId): void {
    const current = this.sessions.get(peerId);
    if (
      !current ||
      (current.status !== 'negotiating' && current.status !== 'connecting') ||
      this.clock.now() - current.startedAt <= this.policy.negotiationTimeoutMs
    ) {
      return;
    }
    this.clearNegotiationTimer(peerId);
    this.sessions.delete(peerId);
    this.connectOperations.delete(peerId);
  }

  private scheduleNegotiationTimeout(peerId: PeerId, negotiationId: string): void {
    this.clearNegotiationTimer(peerId);
    const timer = this.scheduler.setTimeout(() => {
      this.negotiationTimers.delete(peerId);
      const current = this.sessions.get(peerId);
      if (
        this.stopped ||
        current?.negotiationId !== negotiationId ||
        (current.status !== 'negotiating' && current.status !== 'connecting')
      ) {
        return;
      }
      this.connectOperations.delete(peerId);
      this.markFailed(peerId, 'PEER_NEGOTIATION_TIMEOUT');
      void Promise.resolve(this.options.onNegotiationTimeout?.(peerId, negotiationId))
        .catch(() => undefined)
        .finally(() => {
          this.requestReconnect(peerId, 'PEER_NEGOTIATION_TIMEOUT');
        });
    }, this.policy.negotiationTimeoutMs);
    this.negotiationTimers.set(peerId, timer);
  }

  private async runReconnect(peerId: PeerId, reason: string): Promise<void> {
    if (
      this.stopped ||
      this.options.canReconnect?.(peerId, classifyPeerFailure(reason)) === false ||
      !this.options.onReconnect
    ) {
      return;
    }
    try {
      await this.options.onReconnect(peerId);
    } catch (error) {
      const nextReason = error instanceof Error ? error.message : reason;
      this.requestReconnect(peerId, nextReason);
    }
  }

  private markFailed(peerId: PeerId, failureCode: string): void {
    if (this.stopped) {
      return;
    }
    const current = this.sessions.get(peerId);
    if (!current || current.direction !== 'outbound') {
      return;
    }
    this.setSnapshot({
      ...current,
      status: 'failed',
      updatedAt: this.clock.now(),
      failureCode,
      failureKind: classifyPeerFailure(failureCode),
    });
  }

  private clearReconnectTimer(peerId: PeerId): void {
    const timer = this.reconnectTimers.get(peerId);
    if (!timer) {
      return;
    }
    this.scheduler.clearTimeout(timer);
    this.reconnectTimers.delete(peerId);
    const current = this.sessions.get(peerId);
    if (current?.nextReconnectAt) {
      this.setSnapshot({
        ...current,
        nextReconnectAt: undefined,
        updatedAt: this.clock.now(),
      });
    }
  }

  private clearNegotiationTimer(peerId: PeerId): void {
    const timer = this.negotiationTimers.get(peerId);
    if (!timer) {
      return;
    }
    this.scheduler.clearTimeout(timer);
    this.negotiationTimers.delete(peerId);
  }

  private setSnapshot(snapshot: PeerCoordinationSnapshot): void {
    this.sessions.set(snapshot.peerId, snapshot);
    const copy = { ...snapshot };
    for (const listener of this.listeners) {
      listener(copy);
    }
  }

  private assertRunning(): void {
    if (!this.stopped) {
      return;
    }
    throw new AppError({
      code: 'NETWORK_ERROR',
      message: 'Peer session coordinator is stopped',
      safeMessage: 'O coordenador de conexoes P2P esta encerrado.',
      severity: 'warning',
      retryable: true,
      context: {
        scope: 'peer.session.coordinator',
        operation: 'connect',
      },
    });
  }
}

function mapTransportState(state: WebRtcSessionState): PeerCoordinationStatus {
  switch (state) {
    case 'created':
    case 'signaling':
      return 'negotiating';
    case 'connecting':
      return 'connecting';
    case 'connected':
    case 'authenticated':
      return 'connected';
    case 'failed':
      return 'failed';
    case 'disconnected':
    case 'closed':
      return 'disconnected';
  }
}
