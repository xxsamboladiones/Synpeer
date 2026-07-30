import type { NetworkMessage } from '@/network/NetworkMessage';
import type { PeerConnection, PeerTransport } from '@/network/PeerTransport';
import type { PeerId } from '@/network/NetworkTypes';
import { createLogger } from '@/observability/Logger';

import type { PeerSessionService } from './PeerSessionService';
import type { PeerTrustService } from './PeerTrustService';
import type { PeerTrustIdentity } from './TrustedPeerTypes';

interface PeerHandshakeRequest {
  version: 1;
  type: 'peer.handshake.request';
  sessionId: string;
  challenge: string;
  identity: PeerTrustIdentity;
}

interface PeerHandshakeResponse {
  version: 1;
  type: 'peer.handshake.response';
  sessionId: string;
  requestChallenge: string;
  responseChallenge: string;
  identity: PeerTrustIdentity;
  accepted: boolean;
  reason?: string;
}

export class PeerHandshakeProtocol {
  private static readonly HANDSHAKE_TIMEOUT_MS = 10000;
  private readonly logger = createLogger('peer.handshake.protocol');
  private unsubscribe: (() => void) | null = null;
  private pending = new Map<
    string,
    {
      resolve(response: PeerHandshakeResponse): void;
      reject(error: Error): void;
      timeout: ReturnType<typeof globalThis.setTimeout>;
    }
  >();

  constructor(
    private readonly transport: PeerTransport,
    private readonly trustService: PeerTrustService,
    private readonly sessionService: PeerSessionService,
    private readonly onVerified?: (peerId: PeerId) => void,
  ) {}

  start(): void {
    if (this.unsubscribe) {
      return;
    }
    this.unsubscribe = this.transport.subscribe(async (message, connection) => {
      await this.handleMessage(message, connection);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const [sessionId, pending] of this.pending.entries()) {
      globalThis.clearTimeout(pending.timeout);
      pending.reject(new Error(`Peer handshake stopped for session ${sessionId}`));
    }
    this.pending.clear();
  }

  async handshake(peerId: PeerId): Promise<boolean> {
    const connection = this.transport.getConnection(peerId);
    if (!connection) {
      throw new Error(`Peer ${peerId} is not connected`);
    }

    const identity = await this.trustService.createLocalIdentity();
    const { session, challenge } = this.sessionService.startHandshake(
      peerId,
      identity.peerId,
      identity.identityId,
    );
    const request: PeerHandshakeRequest = {
      version: 1,
      type: 'peer.handshake.request',
      sessionId: session.sessionId,
      challenge,
      identity,
    };

    const responsePromise = new Promise<PeerHandshakeResponse>((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        this.pending.delete(session.sessionId);
        this.sessionService.failSession(session.sessionId, 'Handshake timed out');
        reject(new Error(`Peer handshake timed out for ${peerId}`));
      }, PeerHandshakeProtocol.HANDSHAKE_TIMEOUT_MS);
      this.pending.set(session.sessionId, { resolve, reject, timeout });
    });
    try {
      await connection.send('peer.handshake', request, { correlationId: session.sessionId });
    } catch (error) {
      const pending = this.pending.get(session.sessionId);
      if (pending) {
        globalThis.clearTimeout(pending.timeout);
        this.pending.delete(session.sessionId);
      }
      this.sessionService.failSession(
        session.sessionId,
        error instanceof Error ? error.message : 'Handshake send failed',
      );
      throw error;
    }
    const response = await responsePromise;

    if (
      response.accepted &&
      response.sessionId === session.sessionId &&
      response.requestChallenge === challenge &&
      (await this.trustService.verifyAndStoreIdentity(response.identity))
    ) {
      this.sessionService.verifySession(
        session.sessionId,
        response.identity.peerId,
        response.responseChallenge,
      );
      this.onVerified?.(response.identity.peerId);
      return true;
    }

    this.sessionService.failSession(session.sessionId, response.reason ?? 'Handshake rejected');
    return false;
  }

  private async handleMessage(message: NetworkMessage, connection: PeerConnection): Promise<void> {
    if (message.messageType !== 'peer.handshake') {
      return;
    }
    const payload = message.payload;
    if (isHandshakeRequest(payload)) {
      await this.respondToHandshake(payload, connection);
      return;
    }
    if (isHandshakeResponse(payload)) {
      const resolver = this.pending.get(payload.sessionId);
      if (!resolver) {
        this.logger.warn('unexpected_handshake_response', { sessionId: payload.sessionId });
        return;
      }
      this.pending.delete(payload.sessionId);
      globalThis.clearTimeout(resolver.timeout);
      resolver.resolve(payload);
    }
  }

  private async respondToHandshake(
    request: PeerHandshakeRequest,
    connection: PeerConnection,
  ): Promise<void> {
    this.sessionService.acceptRemoteHandshake(
      request.identity.peerId,
      request.sessionId,
      request.challenge,
    );
    const valid = await this.trustService.verifyAndStoreIdentity(request.identity);
    if (valid) {
      this.sessionService.verifySession(
        request.sessionId,
        request.identity.peerId,
        request.challenge,
      );
      this.onVerified?.(request.identity.peerId);
    } else {
      this.sessionService.failSession(request.sessionId, 'Invalid identity signature');
    }

    const identity = await this.trustService.createLocalIdentity();
    const response: PeerHandshakeResponse = {
      version: 1,
      type: 'peer.handshake.response',
      sessionId: request.sessionId,
      requestChallenge: request.challenge,
      responseChallenge: `${request.challenge}:${identity.peerId}:${identity.timestamp}`,
      identity,
      accepted: valid,
      reason: valid ? undefined : 'Invalid identity signature',
    };
    await connection.send('peer.handshake', response, { correlationId: request.sessionId });
  }
}

function isHandshakeRequest(value: unknown): value is PeerHandshakeRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  return (
    payload.version === 1 &&
    payload.type === 'peer.handshake.request' &&
    typeof payload.sessionId === 'string' &&
    typeof payload.challenge === 'string' &&
    isPeerTrustIdentity(payload.identity)
  );
}

function isHandshakeResponse(value: unknown): value is PeerHandshakeResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  return (
    payload.version === 1 &&
    payload.type === 'peer.handshake.response' &&
    typeof payload.sessionId === 'string' &&
    typeof payload.requestChallenge === 'string' &&
    typeof payload.responseChallenge === 'string' &&
    typeof payload.accepted === 'boolean' &&
    isPeerTrustIdentity(payload.identity)
  );
}

function isPeerTrustIdentity(value: unknown): value is PeerTrustIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const identity = value as Record<string, unknown>;
  return (
    typeof identity.peerId === 'string' &&
    typeof identity.identityId === 'string' &&
    typeof identity.publicKey === 'string' &&
    typeof identity.timestamp === 'number' &&
    typeof identity.signature === 'string'
  );
}
