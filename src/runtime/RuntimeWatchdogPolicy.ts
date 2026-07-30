export interface WatchdogPeerState {
  trustStatus: 'verified' | 'blocked' | 'unknown';
  sessionState?: string;
  addresses?: readonly string[];
}

export function shouldAttemptPeerReconnect(
  peers: readonly WatchdogPeerState[],
  canAutoReconnect = true,
): boolean {
  if (!canAutoReconnect) {
    return false;
  }
  return peers.some((peer) => peer.trustStatus === 'verified' && peer.sessionState !== 'blocked');
}
