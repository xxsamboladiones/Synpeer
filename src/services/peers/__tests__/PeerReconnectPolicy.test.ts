import type { PeerId } from '@/network/NetworkTypes';

import {
  calculateReconnectDelay,
  classifyPeerFailure,
  isRetryablePeerFailure,
  type PeerReconnectPolicy,
} from '../PeerReconnectPolicy';

const localPeerId = 'local-peer' as PeerId;
const remotePeerId = 'remote-peer' as PeerId;
const policy: PeerReconnectPolicy = {
  baseDelayMs: 1000,
  maxDelayMs: 8000,
  jitterRatio: 0.2,
  maxAttemptsPerWindow: 8,
  attemptWindowMs: 60_000,
  glareWindowMs: 3_000,
  negotiationTimeoutMs: 10_000,
  transportLimitDelayMs: 120_000,
};

describe('PeerReconnectPolicy', () => {
  it('calculates deterministic bounded backoff', () => {
    const first = calculateReconnectDelay({
      localPeerId,
      remotePeerId,
      attempt: 3,
      policy,
    });
    const repeated = calculateReconnectDelay({
      localPeerId,
      remotePeerId,
      attempt: 3,
      policy,
    });

    expect(repeated).toBe(first);
    expect(first).toBeGreaterThanOrEqual(3200);
    expect(first).toBeLessThanOrEqual(4800);
  });

  it('honors a transport recovery minimum delay', () => {
    expect(
      calculateReconnectDelay({
        localPeerId,
        remotePeerId,
        attempt: 1,
        policy,
        minimumDelayMs: policy.transportLimitDelayMs,
      }),
    ).toBe(policy.transportLimitDelayMs);
  });

  it.each([
    [
      "Failed to construct 'RTCPeerConnection': Cannot create so many PeerConnections",
      'transport-limit',
    ],
    ['WEBRTC_HEARTBEAT_TIMEOUT', 'timeout'],
    ['WebRTC data channel is not open', 'data-channel'],
    ['peer is offline', 'peer-offline'],
    ['handshake rejected', 'handshake'],
  ] as const)('classifies %s as %s', (reason, expected) => {
    expect(classifyPeerFailure(reason)).toBe(expected);
  });

  it('does not retry blocked or removed peers', () => {
    expect(isRetryablePeerFailure(classifyPeerFailure('peer blocked'))).toBe(false);
    expect(isRetryablePeerFailure(classifyPeerFailure('peer removed'))).toBe(false);
    expect(isRetryablePeerFailure(classifyPeerFailure('signaling failed'))).toBe(true);
  });
});
