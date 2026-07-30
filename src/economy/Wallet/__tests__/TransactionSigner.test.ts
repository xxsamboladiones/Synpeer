import { sha256Hex } from '@/utils/hash';
import { createFixedClock } from '@/time/Clock';

import { createCanonicalTransaction, getSignableTransactionBytes } from '../TransactionModel';
import { CryptoTransactionSigner, type TransactionCryptoProvider } from '../TransactionSigner';
import { TransactionStateMachine } from '../TransactionStateMachine';

describe('CryptoTransactionSigner', () => {
  it('signs and verifies canonical transaction bytes with the expected public identity', async () => {
    const publicIdentity = 'peer-public-key';
    const crypto: TransactionCryptoProvider = {
      sign: async (data: string) => sha256Hex(`secret:${data}`),
      verify: async (data: string, signature: string) => signature === sha256Hex(`secret:${data}`),
      getPublicIdentity: () => publicIdentity,
    };
    const signer = new CryptoTransactionSigner(
      crypto,
      new TransactionStateMachine(createFixedClock(1000)),
    );
    const transaction = createCanonicalTransaction({
      type: 'TRANSFER',
      senderId: publicIdentity,
      recipientId: 'bob',
      amount: 10,
      fee: 1,
      createdAt: 1000,
      expiresAt: 2000,
      nonce: 'nonce-1',
      sequence: 1,
    });

    const signed = await signer.sign(transaction);

    expect(await signer.verify(signed)).toBe(true);
    expect(signed.signature).toBe(sha256Hex(`secret:${getSignableTransactionBytes(transaction)}`));
  });

  it('rejects payload altered after signature', async () => {
    const crypto: TransactionCryptoProvider = {
      sign: async (data: string) => sha256Hex(`secret:${data}`),
      verify: async (data: string, signature: string) => signature === sha256Hex(`secret:${data}`),
      getPublicIdentity: () => 'alice',
    };
    const signer = new CryptoTransactionSigner(
      crypto,
      new TransactionStateMachine(createFixedClock(1000)),
    );
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

    const signed = await signer.sign(transaction);
    const tampered = { ...signed, payloadHash: 'different' };

    expect(await signer.verify(tampered)).toBe(false);
  });
});
