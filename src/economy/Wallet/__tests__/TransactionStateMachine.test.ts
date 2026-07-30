import { createFixedClock } from '@/time/Clock';

import { createCanonicalTransaction } from '../TransactionModel';
import { TransactionStateMachine } from '../TransactionStateMachine';

function createTransaction(expiresAt = 5000) {
  return createCanonicalTransaction({
    type: 'TRANSFER',
    senderId: 'alice',
    recipientId: 'bob',
    amount: 10,
    fee: 1,
    createdAt: 1000,
    expiresAt,
    nonce: 'nonce-1',
    sequence: 1,
  });
}

describe('TransactionStateMachine', () => {
  it('applies created -> signed -> pending -> confirmed', () => {
    const clock = createFixedClock(1500);
    const machine = new TransactionStateMachine(clock);
    const signed = machine.sign(createTransaction(), 'sig');
    expect(signed.applied).toBe(true);

    const pending = machine.markPending(signed.transaction);
    expect(pending.applied).toBe(true);

    const confirmed = machine.confirm(pending.transaction, 'ref-1');
    expect(confirmed.applied).toBe(true);
    expect(confirmed.transaction.status).toBe('confirmed');
  });

  it('treats repeated identical confirmation as idempotent', () => {
    const machine = new TransactionStateMachine(createFixedClock(1500));
    const signed = machine.sign(createTransaction(), 'sig');
    const pending = signed.applied ? machine.markPending(signed.transaction) : signed;
    const confirmed = pending.applied ? machine.confirm(pending.transaction, 'ref-1') : pending;

    const repeated = machine.confirm(confirmed.transaction, 'ref-1');

    expect(repeated).toMatchObject({ applied: false, reason: 'already-applied' });
  });

  it('rejects conflicting confirmation references', () => {
    const machine = new TransactionStateMachine(createFixedClock(1500));
    const signed = machine.sign(createTransaction(), 'sig');
    const pending = signed.applied ? machine.markPending(signed.transaction) : signed;
    const confirmed = pending.applied ? machine.confirm(pending.transaction, 'ref-1') : pending;

    expect(machine.confirm(confirmed.transaction, 'ref-2')).toMatchObject({
      applied: false,
      reason: 'conflict',
    });
  });

  it('expires transactions before confirmation', () => {
    const machine = new TransactionStateMachine(createFixedClock(6000));
    const transaction = createTransaction(5000);

    const result = machine.sign(transaction, 'sig');

    expect(result).toMatchObject({ applied: true, previousStatus: 'created' });
    expect(result.transaction.status).toBe('expired');
  });

  it('rejects confirmed -> failed', () => {
    const machine = new TransactionStateMachine(createFixedClock(1500));
    const signed = machine.sign(createTransaction(), 'sig');
    const pending = signed.applied ? machine.markPending(signed.transaction) : signed;
    const confirmed = pending.applied ? machine.confirm(pending.transaction) : pending;

    expect(machine.fail(confirmed.transaction, 'ERR', 'bad')).toMatchObject({
      applied: false,
      reason: 'invalid-transition',
    });
  });
});
