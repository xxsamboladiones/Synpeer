import { createFixedClock } from '@/time/Clock';

import { ContributionLedger } from '../ContributionLedger';

describe('ContributionLedger', () => {
  it('inserts a deterministic entry and treats repeated append as duplicate', () => {
    const ledger = new ContributionLedger(createFixedClock(1000));

    const first = ledger.appendEntry('peer-a', 'CHUNK_SERVED', 1, 'Chunk served', {
      eventId: 'event-1',
    });
    const second = ledger.appendEntry('peer-a', 'CHUNK_SERVED', 1, 'Chunk served', {
      eventId: 'event-1',
    });

    expect(first.inserted).toBe(true);
    expect(second).toMatchObject({ inserted: false, reason: 'duplicate' });
    expect(ledger.getCount()).toBe(1);
  });

  it('detects conflicts for same event id and different content', () => {
    const ledger = new ContributionLedger(createFixedClock(1000));

    ledger.appendEntry('peer-a', 'CHUNK_SERVED', 1, 'Chunk served', { eventId: 'event-1' });
    const conflict = ledger.appendEntry('peer-a', 'CHUNK_SERVED', 2, 'Chunk served', {
      eventId: 'event-1',
    });

    expect(conflict).toMatchObject({ inserted: false, reason: 'conflict' });
    expect(ledger.getCount()).toBe(1);
  });
});
