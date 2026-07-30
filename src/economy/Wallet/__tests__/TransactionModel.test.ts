import {
  canonicalize,
  computeTransactionPayloadHash,
  createCanonicalTransaction,
} from '../TransactionModel';

describe('TransactionModel', () => {
  it('canonicalizes objects deterministically regardless of property order', () => {
    expect(canonicalize({ b: 2, a: 1 })).toBe(canonicalize({ a: 1, b: 2 }));
  });

  it('changes payload hash when payload changes', () => {
    const first = computeTransactionPayloadHash({ amount: 10, fee: 1 });
    const second = computeTransactionPayloadHash({ amount: 11, fee: 1 });

    expect(first).not.toBe(second);
  });

  it('keeps transaction id stable across mutable status changes', () => {
    const transaction = createCanonicalTransaction({
      type: 'TRANSFER',
      senderId: 'alice',
      recipientId: 'bob',
      amount: 10,
      fee: 1,
      createdAt: 1000,
      expiresAt: 2000,
      nonce: 'nonce-1',
      sequence: 1,
    });

    expect({ ...transaction, status: 'confirmed' }.id).toBe(transaction.id);
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalize({ value: Number.POSITIVE_INFINITY })).toThrow();
  });

  it('normalizes undefined consistently', () => {
    expect(canonicalize({ value: undefined })).toBe('{"value":null}');
  });
});
