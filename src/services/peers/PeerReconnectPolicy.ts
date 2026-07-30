import type { PeerId } from '@/network/NetworkTypes';
import { sha256Hex } from '@/utils/hash';

export type PeerFailureKind =
  | 'blocked'
  | 'data-channel'
  | 'handshake'
  | 'ice'
  | 'peer-offline'
  | 'removed'
  | 'signaling'
  | 'timeout'
  | 'transport-limit'
  | 'unknown';

export interface PeerReconnectPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  maxAttemptsPerWindow: number;
  attemptWindowMs: number;
  glareWindowMs: number;
  negotiationTimeoutMs: number;
  transportLimitDelayMs: number;
}

export const defaultPeerReconnectPolicy: PeerReconnectPolicy = {
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
  maxAttemptsPerWindow: 8,
  attemptWindowMs: 5 * 60_000,
  glareWindowMs: 3_000,
  negotiationTimeoutMs: 45_000,
  transportLimitDelayMs: 120_000,
};

export function classifyPeerFailure(reason: string): PeerFailureKind {
  const normalized = reason.toLowerCase();
  if (normalized.includes('blocked')) {
    return 'blocked';
  }
  if (normalized.includes('removed')) {
    return 'removed';
  }
  if (
    normalized.includes('peerconnection limit') ||
    normalized.includes('peer connection limit') ||
    normalized.includes('too many peerconnections') ||
    normalized.includes('cannot create so many peerconnections')
  ) {
    return 'transport-limit';
  }
  if (normalized.includes('handshake')) {
    return 'handshake';
  }
  if (normalized.includes('heartbeat') || normalized.includes('timeout')) {
    return 'timeout';
  }
  if (normalized.includes('data channel') || normalized.includes('data-channel')) {
    return 'data-channel';
  }
  if (normalized.includes('ice') || normalized.includes('webrtc_connection_failed')) {
    return 'ice';
  }
  if (
    normalized.includes('signal') ||
    normalized.includes('offer') ||
    normalized.includes('answer')
  ) {
    return 'signaling';
  }
  if (normalized.includes('offline') || normalized.includes('disconnected')) {
    return 'peer-offline';
  }
  return 'unknown';
}

export function isRetryablePeerFailure(kind: PeerFailureKind): boolean {
  return kind !== 'blocked' && kind !== 'removed';
}

export function calculateReconnectDelay(input: {
  localPeerId: PeerId;
  remotePeerId: PeerId;
  attempt: number;
  policy?: PeerReconnectPolicy;
  minimumDelayMs?: number;
}): number {
  const policy = input.policy ?? defaultPeerReconnectPolicy;
  const attempt = Math.max(1, input.attempt);
  const exponentialDelay = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.min(attempt - 1, 10),
  );
  const digest = sha256Hex(`${input.localPeerId}:${input.remotePeerId}:${attempt}`);
  const sample = Number.parseInt(digest.slice(0, 8), 16) / 0xffffffff;
  const jitter = 1 - policy.jitterRatio + sample * policy.jitterRatio * 2;
  const delayed = Math.round(exponentialDelay * jitter);
  return Math.max(input.minimumDelayMs ?? 0, delayed);
}
