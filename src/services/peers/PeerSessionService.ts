import type { PeerId } from '@/network/NetworkTypes';
import { canonicalize } from '@/economy/Wallet/TransactionModel';
import { sha256Hex } from '@/utils/hash';
import { createLogger } from '@/observability/Logger';

import type { PeerSession, PeerSessionState } from './TrustedPeerTypes';
import type { TrustedPeerRepository } from './TrustedPeerRepository';

export interface PeerSessionClock {
  now(): number;
}

export interface PeerSessionStart {
  session: PeerSession;
  challenge: string;
}

const HANDSHAKE_TTL_MS = 5 * 60 * 1000;

export class PeerSessionService {
  private readonly logger = createLogger('peer.session');
  private readonly sessions = new Map<string, PeerSession>();
  private counter = 0;

  constructor(
    private readonly repository: TrustedPeerRepository,
    private readonly clock: PeerSessionClock = { now: () => Date.now() },
  ) {}

  startHandshake(peerId: PeerId, localPeerId: PeerId, localIdentity: string): PeerSessionStart {
    const createdAt = this.clock.now();
    const challenge = sha256Hex(
      canonicalize({
        peerId,
        localPeerId,
        localIdentity,
        createdAt,
        sequence: this.counter,
      }),
    );
    this.counter += 1;
    const sessionId = `ps_${sha256Hex(canonicalize({ peerId, localPeerId, challenge })).slice(0, 32)}`;
    const session: PeerSession = {
      sessionId,
      peerId,
      state: 'connecting',
      createdAt,
      updatedAt: createdAt,
      localChallenge: challenge,
    };

    this.sessions.set(sessionId, session);
    this.repository.upsert({ peerId, source: this.repository.get(peerId)?.source ?? 'discovery' });
    this.repository.updateSessionState(peerId, 'connecting', { sessionId });
    return { session, challenge };
  }

  acceptRemoteHandshake(peerId: PeerId, sessionId: string, remoteChallenge: string): PeerSession {
    const now = this.clock.now();
    const session: PeerSession = {
      sessionId,
      peerId,
      state: 'connecting',
      createdAt: now,
      updatedAt: now,
      remoteChallenge,
    };
    this.sessions.set(sessionId, session);
    this.repository.upsert({ peerId, source: this.repository.get(peerId)?.source ?? 'discovery' });
    this.repository.updateSessionState(peerId, 'connecting', { sessionId });
    return session;
  }

  verifySession(sessionId: string, peerId: PeerId, remoteChallenge?: string): PeerSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.peerId !== peerId) {
      this.repository.updateSessionState(peerId, 'failed', {
        sessionId,
        reason: 'Session not found',
      });
      return null;
    }
    if (this.isExpired(session)) {
      return this.failSession(sessionId, 'Handshake expired');
    }

    const verified = {
      ...session,
      state: 'verified' as const,
      remoteChallenge: remoteChallenge ?? session.remoteChallenge,
      updatedAt: this.clock.now(),
    };
    this.sessions.set(sessionId, verified);
    this.repository.recordHandshakeSuccess(peerId, sessionId);
    return verified;
  }

  failSession(sessionId: string, reason: string): PeerSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.logger.warn('session_fail_missing', { sessionId });
      return null;
    }
    const failed = {
      ...session,
      state: 'failed' as const,
      lastError: reason,
      updatedAt: this.clock.now(),
    };
    this.sessions.set(sessionId, failed);
    this.repository.updateSessionState(session.peerId, 'failed', { sessionId, reason });
    return failed;
  }

  disconnect(peerId: PeerId): void {
    this.repository.updateSessionState(peerId, 'disconnected');
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.peerId === peerId && session.state === 'verified') {
        this.sessions.set(sessionId, {
          ...session,
          state: 'disconnected',
          updatedAt: this.clock.now(),
        });
      }
    }
  }

  getSession(sessionId: string): PeerSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  getPeerState(peerId: PeerId): PeerSessionState {
    return this.repository.get(peerId)?.sessionState ?? 'unknown';
  }

  private isExpired(session: PeerSession): boolean {
    return this.clock.now() - session.createdAt > HANDSHAKE_TTL_MS;
  }
}
