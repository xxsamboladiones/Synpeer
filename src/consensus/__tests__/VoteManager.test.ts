import { createFixedClock } from '@/time/Clock';

import { VoteManager } from '../VoteManager';

describe('VoteManager', () => {
  it('treats identical votes from the same voter as idempotent duplicates', () => {
    const manager = new VoteManager(createFixedClock(1000));

    const first = manager.tryCastVote('contribution-1', 'peer-a', 'approve', 'ok');
    const second = manager.tryCastVote('contribution-1', 'peer-a', 'approve', 'ok');

    expect(first).toMatchObject({ accepted: true, duplicate: false });
    expect(second).toMatchObject({ accepted: true, duplicate: true });
    expect(manager.getContributionVoteCount('contribution-1')).toBe(1);
  });

  it('rejects conflicting vote from the same voter', () => {
    const manager = new VoteManager(createFixedClock(1000));

    manager.tryCastVote('contribution-1', 'peer-a', 'approve');
    const conflict = manager.tryCastVote('contribution-1', 'peer-a', 'reject');

    expect(conflict).toMatchObject({ accepted: false, reason: 'conflict' });
    expect(manager.countVotes('contribution-1')).toMatchObject({ total: 1, approve: 1, reject: 0 });
  });
});
