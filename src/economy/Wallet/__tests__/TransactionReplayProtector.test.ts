import { createCanonicalTransaction } from '../TransactionModel';
import { TransactionReplayProtector } from '../TransactionReplayProtector';

function createTransaction(senderId = 'alice', nonce = 'nonce-1', sequence = 1) {
  return createCanonicalTransaction({
    type: 'TRANSFER',
    senderId,
    recipientId: 'bob',
    amount: 10,
    fee: 1,
    createdAt: 1000,
    expiresAt: 2000,
    nonce,
    sequence,
  });
}

describe('TransactionReplayProtector', () => {
  it('rejects the same transaction id twice', () => {
    const protector = new TransactionReplayProtector();
    const transaction = createTransaction();

    expect(protector.record(transaction)).toEqual({ accepted: true });
    expect(protector.record(transaction)).toEqual({ accepted: false, reason: 'duplicate-id' });
  });

  it('rejects reused nonce by same sender but allows it for another sender', () => {
    const protector = new TransactionReplayProtector();

    expect(protector.record(createTransaction('alice', 'same', 1))).toEqual({ accepted: true });
    expect(protector.record(createTransaction('alice', 'same', 2))).toEqual({
      accepted: false,
      reason: 'nonce-reused',
    });
    expect(protector.record(createTransaction('carol', 'same', 1))).toEqual({ accepted: true });
  });

  it('survives snapshot import', () => {
    const first = new TransactionReplayProtector();
    first.record(createTransaction('alice', 'nonce-1', 3));

    const second = new TransactionReplayProtector();
    second.importSnapshot(first.exportSnapshot());

    expect(second.record(createTransaction('alice', 'nonce-2', 2))).toEqual({
      accepted: false,
      reason: 'sequence-regression',
    });
  });
});
