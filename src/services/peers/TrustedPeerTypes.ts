import type { PeerId } from '@/network/NetworkTypes';

export type TrustedPeerStatus = 'unknown' | 'verified' | 'blocked';
export type TrustedPeerSource = 'invite' | 'manual' | 'discovery';
export type PeerSessionState =
  'unknown' | 'connecting' | 'verified' | 'failed' | 'blocked' | 'disconnected';

export interface TrustedPeerProjection {
  trustScore: number;
  successfulHandshakes: number;
  failedHandshakes: number;
  lastFailureReason?: string;
  lastProjectedAt: number;
}

export interface TrustedPeer {
  peerId: PeerId;
  identityId?: string;
  displayName?: string;
  publicKey?: string;
  addresses: string[];
  trustStatus: TrustedPeerStatus;
  lastSeenAt?: number;
  lastConnectedAt?: number;
  lastSyncAt?: number;
  addedAt: number;
  updatedAt: number;
  source: TrustedPeerSource;
  syncedObjects: number;
  sessionState: PeerSessionState;
  lastHandshakeAt?: number;
  activeSessionId?: string;
  syncCursor?: string;
  projection?: TrustedPeerProjection;
}

export interface PeerInvite {
  version: 1;
  peerId: PeerId;
  identityId?: string;
  addresses: string[];
  createdAt: number;
  expiresAt?: number;
  nonce?: string;
  signature?: string;
}

export interface PeerTrustIdentity {
  peerId: PeerId;
  identityId: string;
  displayName?: string;
  publicKey: string;
  timestamp: number;
  signature: string;
}

export interface PeerSession {
  sessionId: string;
  peerId: PeerId;
  state: PeerSessionState;
  createdAt: number;
  updatedAt: number;
  localChallenge?: string;
  remoteChallenge?: string;
  lastError?: string;
}
