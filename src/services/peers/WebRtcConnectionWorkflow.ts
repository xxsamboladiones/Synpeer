import { AppError } from '@/errors/AppError';
import type { PeerId } from '@/network/NetworkTypes';
import { decodeWebRtcSignal } from '@/network/WebRtcSignaling';
import type { WebRtcSessionSnapshot } from '@/network/WebRtcPeerTransport';
import { createLogger } from '@/observability/Logger';

import type { TrustedPeerRepository } from './TrustedPeerRepository';

export type WebRtcAutoConnectRuntimeResult =
  { mode: 'auto-signaling' } | { mode: 'manual'; offerCode: string };

export interface WebRtcConnectionRuntime {
  createPeerOffer?: (peerId?: PeerId) => Promise<string>;
  acceptPeerOffer?: (offerCode: string) => Promise<string>;
  applyPeerAnswer?: (answerCode: string) => Promise<void>;
  connectToPeer?: (peerId: PeerId) => Promise<WebRtcAutoConnectRuntimeResult>;
  hasPendingPeerOffer?: (sessionId?: string) => boolean;
  getSessions?: () => WebRtcSessionSnapshot[];
  isWebRtcAvailable?: () => boolean;
}

export type WebRtcPairingStep =
  'offer-created' | 'answer-created' | 'answer-applied' | 'auto-connect-started';

export interface WebRtcPairingResult {
  step: WebRtcPairingStep;
  sessionId: string;
  remotePeerId: PeerId;
  code?: string;
  sessions: WebRtcSessionSnapshot[];
}

export class WebRtcConnectionWorkflow {
  private readonly logger = createLogger('WebRtcConnectionWorkflow');

  constructor(
    private readonly trustedPeerRepository: TrustedPeerRepository,
    private readonly getRuntime: () => unknown,
  ) {}

  async connectPeer(peerId: PeerId): Promise<WebRtcPairingResult> {
    const runtime = this.getAvailableRuntime('connect-peer');
    this.assertPeerCanConnect(peerId, 'connect-peer');

    if (!runtime.connectToPeer) {
      return await this.createOfferForPeer(peerId);
    }

    const connection = await runtime.connectToPeer(peerId);
    if (connection.mode === 'manual') {
      const signal = decodeWebRtcSignal(connection.offerCode);
      this.trustedPeerRepository.updateSessionState(peerId, 'connecting', {
        sessionId: signal.sessionId,
      });
      this.logger.info('manual_offer_created_from_connect', {
        peerId,
        sessionId: signal.sessionId,
      });
      return {
        step: 'offer-created',
        sessionId: signal.sessionId,
        remotePeerId: peerId,
        code: connection.offerCode,
        sessions: this.getSessions(),
      };
    }

    this.trustedPeerRepository.updateSessionState(peerId, 'connecting');
    this.logger.info('auto_connect_started', { peerId });
    return {
      step: 'auto-connect-started',
      sessionId: 'auto-signaling',
      remotePeerId: peerId,
      sessions: this.getSessions(),
    };
  }

  async createOfferForPeer(peerId?: PeerId): Promise<WebRtcPairingResult> {
    const runtime = this.getAvailableRuntime('create-offer');
    if (!runtime.createPeerOffer) {
      throw this.createUnavailableError('create-offer');
    }

    if (peerId) {
      this.assertPeerCanConnect(peerId, 'create-offer');
    }

    const code = await runtime.createPeerOffer(peerId);
    const signal = decodeWebRtcSignal(code);
    if (signal.type !== 'offer') {
      throw this.createProtocolError('Expected an offer from WebRTC transport', 'create-offer');
    }

    if (peerId) {
      this.trustedPeerRepository.updateSessionState(peerId, 'connecting', {
        sessionId: signal.sessionId,
      });
    }

    this.logger.info('offer_created', {
      peerId: peerId ?? signal.peerId,
      sessionId: signal.sessionId,
    });

    return {
      step: 'offer-created',
      sessionId: signal.sessionId,
      remotePeerId: peerId ?? signal.peerId,
      code,
      sessions: this.getSessions(),
    };
  }

  async acceptOffer(offerCode: string): Promise<WebRtcPairingResult> {
    const runtime = this.getAvailableRuntime('accept-offer');
    if (!runtime.acceptPeerOffer) {
      throw this.createUnavailableError('accept-offer');
    }

    const offer = decodeWebRtcSignal(offerCode);
    if (offer.type !== 'offer') {
      throw this.createProtocolError(
        'Paste a WebRTC offer before creating an answer',
        'accept-offer',
      );
    }

    this.ensureKnownPeer(offer.peerId);
    this.trustedPeerRepository.updateSessionState(offer.peerId, 'connecting', {
      sessionId: offer.sessionId,
    });

    const answerCode = await runtime.acceptPeerOffer(offerCode);
    const answer = decodeWebRtcSignal(answerCode);
    if (answer.type !== 'answer' || answer.sessionId !== offer.sessionId) {
      throw this.createProtocolError('WebRTC transport returned an invalid answer', 'accept-offer');
    }

    this.logger.info('answer_created', {
      peerId: offer.peerId,
      sessionId: offer.sessionId,
    });

    return {
      step: 'answer-created',
      sessionId: offer.sessionId,
      remotePeerId: offer.peerId,
      code: answerCode,
      sessions: this.getSessions(),
    };
  }

  async applyAnswer(answerCode: string): Promise<WebRtcPairingResult> {
    const runtime = this.getAvailableRuntime('apply-answer');
    if (!runtime.applyPeerAnswer) {
      throw this.createUnavailableError('apply-answer');
    }

    const answer = decodeWebRtcSignal(answerCode);
    if (answer.type !== 'answer') {
      throw this.createProtocolError('Paste a WebRTC answer generated by the peer', 'apply-answer');
    }

    if (!runtime.hasPendingPeerOffer?.(answer.sessionId)) {
      throw new AppError({
        code: 'NETWORK_ERROR',
        message: 'WebRTC answer does not match an active outbound offer',
        safeMessage:
          'Esta resposta nao pertence a uma oferta ativa neste navegador. Crie uma nova oferta e gere outra resposta.',
        severity: 'warning',
        retryable: true,
        context: {
          scope: 'webrtc.connection.workflow',
          operation: 'apply-answer',
          peerId: answer.peerId,
        },
      });
    }

    this.ensureKnownPeer(answer.peerId);
    this.trustedPeerRepository.updateSessionState(answer.peerId, 'connecting', {
      sessionId: answer.sessionId,
    });

    await runtime.applyPeerAnswer(answerCode);
    this.logger.info('answer_applied', {
      peerId: answer.peerId,
      sessionId: answer.sessionId,
    });

    return {
      step: 'answer-applied',
      sessionId: answer.sessionId,
      remotePeerId: answer.peerId,
      sessions: this.getSessions(),
    };
  }

  hasPendingOffer(sessionId?: string): boolean {
    return toWebRtcConnectionRuntime(this.getRuntime()).hasPendingPeerOffer?.(sessionId) ?? false;
  }

  getSessions(): WebRtcSessionSnapshot[] {
    return toWebRtcConnectionRuntime(this.getRuntime()).getSessions?.() ?? [];
  }

  private ensureKnownPeer(peerId: PeerId): void {
    const existing = this.trustedPeerRepository.get(peerId);
    if (existing?.trustStatus === 'blocked') {
      throw new AppError({
        code: 'TRUST_ERROR',
        message: 'Blocked peer cannot be connected',
        safeMessage: 'Este peer esta bloqueado. Desbloqueie antes de conectar.',
        severity: 'warning',
        retryable: false,
        context: {
          scope: 'webrtc.connection.workflow',
          operation: 'ensure-known-peer',
          peerId,
        },
      });
    }
    if (!existing) {
      this.trustedPeerRepository.upsert({
        peerId,
        source: 'discovery',
        trustStatus: 'unknown',
      });
    }
  }

  private assertPeerCanConnect(peerId: PeerId, operation: string): void {
    const existing = this.trustedPeerRepository.get(peerId);
    if (existing?.trustStatus === 'blocked') {
      throw new AppError({
        code: 'TRUST_ERROR',
        message: 'Blocked peer cannot be connected',
        safeMessage: 'Este peer esta bloqueado. Desbloqueie antes de conectar.',
        severity: 'warning',
        retryable: false,
        context: {
          scope: 'webrtc.connection.workflow',
          operation,
          peerId,
        },
      });
    }
  }

  private getAvailableRuntime(operation: string): WebRtcConnectionRuntime {
    const runtime = toWebRtcConnectionRuntime(this.getRuntime());
    if (runtime.isWebRtcAvailable?.() === false) {
      throw this.createUnavailableError(operation);
    }
    return runtime;
  }

  private createUnavailableError(operation: string): AppError {
    return new AppError({
      code: 'UNSUPPORTED_CAPABILITY',
      message: 'WebRTC peer connection is not available in this runtime',
      safeMessage: 'A conexao P2P por WebRTC nao esta disponivel neste ambiente.',
      severity: 'warning',
      retryable: false,
      context: {
        scope: 'webrtc.connection.workflow',
        operation,
      },
    });
  }

  private createProtocolError(message: string, operation: string): AppError {
    return new AppError({
      code: 'NETWORK_ERROR',
      message,
      safeMessage: 'O codigo de pareamento WebRTC e invalido ou foi colado no campo errado.',
      severity: 'warning',
      retryable: true,
      context: {
        scope: 'webrtc.connection.workflow',
        operation,
      },
    });
  }
}

function toWebRtcConnectionRuntime(value: unknown): WebRtcConnectionRuntime {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const createPeerOffer = record.createPeerOffer;
  const acceptPeerOffer = record.acceptPeerOffer;
  const applyPeerAnswer = record.applyPeerAnswer;
  const connectToPeer = record.connectToPeer;
  const hasPendingPeerOffer = record.hasPendingPeerOffer;
  const getSessions = record.getSessions;
  const isWebRtcAvailable = record.isWebRtcAvailable;
  return {
    createPeerOffer: isAsyncStringFunction(createPeerOffer)
      ? (peerId) => createPeerOffer.call(value, peerId)
      : undefined,
    acceptPeerOffer: isAsyncStringFromStringFunction(acceptPeerOffer)
      ? (input) => acceptPeerOffer.call(value, input)
      : undefined,
    applyPeerAnswer: isAsyncVoidFromStringFunction(applyPeerAnswer)
      ? (input) => applyPeerAnswer.call(value, input)
      : undefined,
    connectToPeer: isAsyncConnectToPeerFunction(connectToPeer)
      ? (input) => connectToPeer.call(value, input)
      : undefined,
    hasPendingPeerOffer: isBooleanFromOptionalStringFunction(hasPendingPeerOffer)
      ? (input) => hasPendingPeerOffer.call(value, input)
      : undefined,
    getSessions: isSessionSnapshotListFunction(getSessions)
      ? () => getSessions.call(value)
      : undefined,
    isWebRtcAvailable: isBooleanFunction(isWebRtcAvailable)
      ? () => isWebRtcAvailable.call(value)
      : undefined,
  };
}

function isAsyncStringFunction(value: unknown): value is (peerId?: PeerId) => Promise<string> {
  return typeof value === 'function';
}

function isAsyncStringFromStringFunction(
  value: unknown,
): value is (input: string) => Promise<string> {
  return typeof value === 'function';
}

function isAsyncVoidFromStringFunction(value: unknown): value is (input: string) => Promise<void> {
  return typeof value === 'function';
}

function isAsyncConnectToPeerFunction(
  value: unknown,
): value is (peerId: PeerId) => Promise<WebRtcAutoConnectRuntimeResult> {
  return typeof value === 'function';
}

function isBooleanFromOptionalStringFunction(value: unknown): value is (input?: string) => boolean {
  return typeof value === 'function';
}

function isSessionSnapshotListFunction(value: unknown): value is () => WebRtcSessionSnapshot[] {
  return typeof value === 'function';
}

function isBooleanFunction(value: unknown): value is () => boolean {
  return typeof value === 'function';
}
