import { createFixedClock } from '@/time/Clock';

import { WalletService } from '../WalletService';

describe('WalletService', () => {
  it('creates deterministic canonical metadata for local transfers', async () => {
    const clock = createFixedClock(1000);
    const service = new WalletService(clock);
    service.createWallet('peer-a');
    await service.addBalance(100, 'REWARD');

    const transferred = await service.transfer('0xrecipient', 25, 1);

    expect(transferred).toBe(true);
    const transfer = service.getTransactionsByType('TRANSFER')[0];
    expect(transfer.id).toMatch(/^tx_/);
    expect(transfer.status).toBe('CONFIRMED');
    expect(transfer.metadata).toMatchObject({
      canonicalStatus: 'confirmed',
      sequence: 2,
    });
    expect(typeof transfer.metadata?.payloadHash).toBe('string');
  });

  it('keeps confirmed canonical transactions immutable through legacy failTransaction', async () => {
    const service = new WalletService(createFixedClock(1000));
    service.createWallet('peer-a');
    await service.addBalance(10, 'REWARD');
    const transaction = service.getTransactions()[0];

    expect(service.failTransaction(transaction.id, 'manual failure')).toBe(false);
    expect(service.getTransaction(transaction.id)?.metadata).toMatchObject({
      canonicalStatus: 'confirmed',
    });
  });
});
