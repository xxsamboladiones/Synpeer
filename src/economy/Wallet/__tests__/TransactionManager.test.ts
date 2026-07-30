import { createFixedClock } from '@/time/Clock';

import { TransactionManager } from '../Transaction';

describe('TransactionManager compatibility facade', () => {
  it('creates deterministic canonical ids without random or wall-clock ids', async () => {
    const first = new TransactionManager(createFixedClock(1000));
    const second = new TransactionManager(createFixedClock(1000));

    const a = await first.createTransaction('alice', 'bob', 10, 'TRANSFER', 1, 'test', 'sig');
    const b = await second.createTransaction('alice', 'bob', 10, 'TRANSFER', 1, 'test', 'sig');

    expect(a.id).toBe(b.id);
    expect(a.status).toBe('PENDING');
  });

  it('uses the state machine for invalid confirmed -> failed transitions', async () => {
    const manager = new TransactionManager(createFixedClock(1000));
    const transaction = await manager.createTransaction(
      'alice',
      'bob',
      10,
      'TRANSFER',
      1,
      'test',
      'sig',
    );

    expect(manager.confirmTransaction(transaction.id)).toBe(true);
    expect(manager.failTransaction(transaction.id, 'late failure')).toBe(false);
    expect(manager.getTransaction(transaction.id)?.status).toBe('CONFIRMED');
  });
});
