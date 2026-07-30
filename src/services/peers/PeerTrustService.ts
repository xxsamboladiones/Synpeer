import type { PeerId } from '@/network/NetworkTypes';
import type { CryptoService } from '@/crypto/CryptoService';
import type { NetworkService } from '@/services/network/NetworkService';

import type { TrustedPeerRepository } from './TrustedPeerRepository';
import type { PeerTrustIdentity } from './TrustedPeerTypes';
import { PeerSessionService } from './PeerSessionService';

export interface LegacyTrustTransportMessage {
  packet: string;
}

export interface LegacyTrustTransport {
  request<T>(channel: 'trust', packet: string, targetPeerIds?: readonly PeerId[]): Promise<T[]>;
  subscribe(
    channel: 'trust',
    handler: (message: LegacyTrustTransportMessage) => Promise<void> | void,
  ): () => void;
  respond<T>(
    channel: 'trust',
    responder: (message: LegacyTrustTransportMessage) => Promise<T | null> | T | null,
  ): () => void;
}

type TrustHandshakeRequest = {
  type: 'TRUST_HANDSHAKE';
  version: 1;
  sessionId: string;
  challenge: string;
  identity: PeerTrustIdentity;
};

type TrustHandshakeResponse = {
  type: 'TRUST_HANDSHAKE_RESPONSE';
  version: 1;
  sessionId: string;
  requestChallenge: string;
  responseChallenge: string;
  identity: PeerTrustIdentity;
  accepted: boolean;
  reason?: string;
};

type TrustMessage = TrustHandshakeRequest | TrustHandshakeResponse;

export class PeerTrustService {
  private unsubscribeHandler: (() => void) | null = null;
  private unsubscribeResponder: (() => void) | null = null;

  constructor(
    private readonly repository: TrustedPeerRepository,
    private readonly cryptoService: CryptoService,
    private readonly getNetworkService: () => NetworkService,
    private readonly transport: LegacyTrustTransport | null = null,
    private readonly sessionService: PeerSessionService = new PeerSessionService(repository),
  ) {}

  start(): void {
    if (this.unsubscribeHandler || this.unsubscribeResponder) {
      return;
    }
    if (!this.transport) {
      return;
    }

    this.unsubscribeHandler = this.transport.subscribe('trust', async (message) => {
      await this.processTransportMessage(message);
    });
    this.unsubscribeResponder = this.transport.respond<TrustHandshakeResponse>(
      'trust',
      async (message) => {
        return await this.respondToHandshake(message);
      },
    );
  }

  stop(): void {
    this.unsubscribeHandler?.();
    this.unsubscribeResponder?.();
    this.unsubscribeHandler = null;
    this.unsubscribeResponder = null;
  }

  async handshake(peerId: PeerId): Promise<boolean> {
    const peer = this.repository.get(peerId);
    if (peer?.trustStatus === 'blocked') {
      return false;
    }

    this.repository.upsert({ peerId, source: peer?.source ?? 'discovery' });
    if (!this.transport) {
      return false;
    }
    const identity = await this.createLocalIdentity();
    const { session, challenge } = this.sessionService.startHandshake(
      peerId,
      identity.peerId,
      identity.identityId,
    );
    const request: TrustHandshakeRequest = {
      type: 'TRUST_HANDSHAKE',
      version: 1,
      sessionId: session.sessionId,
      challenge,
      identity,
    };
    const responses = await this.transport.request<TrustHandshakeResponse>(
      'trust',
      JSON.stringify(request),
      [peerId],
    );
    let accepted = false;
    for (const response of responses) {
      if (
        response.version === 1 &&
        response.sessionId === session.sessionId &&
        response.requestChallenge === challenge &&
        response.accepted &&
        (await this.verifyAndStoreAsync(response.identity))
      ) {
        this.sessionService.verifySession(
          session.sessionId,
          response.identity.peerId,
          response.responseChallenge,
        );
        accepted = true;
      }
    }
    if (accepted) {
      this.repository.recordConnection(peerId);
    } else {
      this.sessionService.failSession(session.sessionId, 'Handshake rejected or no valid response');
    }
    return accepted;
  }

  async createLocalIdentity(displayName?: string): Promise<PeerTrustIdentity> {
    const networkService = this.getNetworkService();
    const localIdentity = await networkService.getLocalIdentity();
    const identityId = this.cryptoService.getPublicIdentity() ?? localIdentity?.publicIdentity;
    const peerId = networkService.getPeerManager().getPeerId() ?? localIdentity?.peerId;
    if (!identityId || !peerId) {
      throw new Error('Local identity is not available for trust handshake');
    }

    const timestamp = Date.now();
    const unsigned = this.createSignedPayload({
      peerId,
      identityId,
      displayName,
      publicKey: identityId,
      timestamp,
    });
    const signature = await this.cryptoService.sign(unsigned);
    return {
      peerId,
      identityId,
      displayName,
      publicKey: identityId,
      timestamp,
      signature,
    };
  }

  async verifyIdentity(identity: PeerTrustIdentity): Promise<boolean> {
    if (Date.now() - identity.timestamp > 5 * 60 * 1000) {
      return false;
    }
    const unsigned = this.createSignedPayload(identity);
    return await this.cryptoService.verify(unsigned, identity.signature, identity.publicKey);
  }

  async verifyAndStoreIdentity(identity: PeerTrustIdentity): Promise<boolean> {
    return await this.verifyAndStoreAsync(identity);
  }

  private async processTransportMessage(message: LegacyTrustTransportMessage): Promise<void> {
    const parsed = this.parseMessage(message.packet);
    if (!parsed) {
      return;
    }

    if (parsed.type === 'TRUST_HANDSHAKE_RESPONSE' && parsed.accepted) {
      await this.verifyAndStoreAsync(parsed.identity);
    }
  }

  private async respondToHandshake(
    message: LegacyTrustTransportMessage,
  ): Promise<TrustHandshakeResponse | null> {
    const parsed = this.parseMessage(message.packet);
    if (!parsed || parsed.type !== 'TRUST_HANDSHAKE') {
      return null;
    }

    const remoteIdentity = parsed.identity;
    const existing = this.repository.get(remoteIdentity.peerId);
    this.sessionService.acceptRemoteHandshake(
      remoteIdentity.peerId,
      parsed.sessionId,
      parsed.challenge,
    );
    if (existing?.trustStatus === 'blocked') {
      return {
        type: 'TRUST_HANDSHAKE_RESPONSE',
        version: 1,
        sessionId: parsed.sessionId,
        requestChallenge: parsed.challenge,
        responseChallenge: '',
        identity: await this.createLocalIdentity(),
        accepted: false,
        reason: 'Peer is blocked',
      };
    }

    const valid = await this.verifyIdentity(remoteIdentity);
    if (valid) {
      this.repository.markVerified(remoteIdentity.peerId, remoteIdentity);
      this.repository.recordConnection(remoteIdentity.peerId);
      this.sessionService.verifySession(parsed.sessionId, remoteIdentity.peerId, parsed.challenge);
    } else {
      this.repository.upsert({
        peerId: remoteIdentity.peerId,
        trustStatus: 'unknown',
        source: 'discovery',
      });
      this.sessionService.failSession(parsed.sessionId, 'Invalid identity signature');
    }

    const localIdentity = await this.createLocalIdentity();
    return {
      type: 'TRUST_HANDSHAKE_RESPONSE',
      version: 1,
      sessionId: parsed.sessionId,
      requestChallenge: parsed.challenge,
      responseChallenge: this.createResponseChallenge(parsed.challenge, localIdentity),
      identity: localIdentity,
      accepted: valid,
      reason: valid ? undefined : 'Invalid identity signature',
    };
  }

  private async verifyAndStoreAsync(identity: PeerTrustIdentity): Promise<boolean> {
    const existing = this.repository.get(identity.peerId);
    if (existing?.trustStatus === 'blocked') {
      return false;
    }

    const valid = await this.verifyIdentity(identity);
    if (!valid) {
      this.repository.upsert({
        peerId: identity.peerId,
        trustStatus: 'unknown',
        source: existing?.source ?? 'discovery',
      });
      return false;
    }

    this.repository.markVerified(identity.peerId, identity);
    this.repository.recordConnection(identity.peerId);
    return true;
  }

  private parseMessage(packet: string): TrustMessage | null {
    try {
      const parsed = JSON.parse(packet) as TrustMessage;
      if (
        (parsed.type === 'TRUST_HANDSHAKE' || parsed.type === 'TRUST_HANDSHAKE_RESPONSE') &&
        parsed.version === 1
      ) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  private createSignedPayload(identity: Omit<PeerTrustIdentity, 'signature'>): string {
    return JSON.stringify({
      peerId: identity.peerId,
      identityId: identity.identityId,
      displayName: identity.displayName ?? null,
      publicKey: identity.publicKey,
      timestamp: identity.timestamp,
    });
  }

  private createResponseChallenge(challenge: string, identity: PeerTrustIdentity): string {
    return JSON.stringify({
      challenge,
      peerId: identity.peerId,
      identityId: identity.identityId,
      timestamp: identity.timestamp,
    });
  }
}
