import { shouldAttemptPeerReconnect } from '../RuntimeWatchdogPolicy';

describe('RuntimeWatchdogPolicy', () => {
  it('does not reconnect when no trusted peers exist yet', () => {
    expect(shouldAttemptPeerReconnect([])).toBe(false);
    expect(shouldAttemptPeerReconnect([{ trustStatus: 'unknown' }])).toBe(false);
  });

  it('reconnects only when at least one verified peer is not blocked', () => {
    expect(
      shouldAttemptPeerReconnect([
        { trustStatus: 'blocked', sessionState: 'blocked' },
        {
          trustStatus: 'verified',
          sessionState: 'unknown',
          addresses: ['/ip4/127.0.0.1/tcp/4001'],
        },
      ]),
    ).toBe(true);
    expect(
      shouldAttemptPeerReconnect([
        { trustStatus: 'verified', sessionState: 'blocked', addresses: ['/ip4/127.0.0.1/tcp/1'] },
      ]),
    ).toBe(false);
  });

  it('does not reconnect when the runtime only supports manual WebRTC signaling', () => {
    expect(
      shouldAttemptPeerReconnect(
        [{ trustStatus: 'verified', sessionState: 'unknown', addresses: ['/ip4/127.0.0.1/tcp/1'] }],
        false,
      ),
    ).toBe(false);
  });

  it('reconnects verified peers without dialable addresses when automatic signaling exists', () => {
    expect(shouldAttemptPeerReconnect([{ trustStatus: 'verified', addresses: [] }])).toBe(true);
  });

  it('restores a persisted connecting peer after a page reload', () => {
    expect(
      shouldAttemptPeerReconnect([{ trustStatus: 'verified', sessionState: 'connecting' }]),
    ).toBe(true);
  });
});
