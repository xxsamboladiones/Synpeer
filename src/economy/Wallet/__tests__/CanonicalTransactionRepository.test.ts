import { openDatabaseService } from '@/database/sqliteAdapter.web';
import { createFixedClock } from '@/time/Clock';

import { CanonicalTransactionRepository } from '../CanonicalTransactionRepository';
import { createCanonicalTransaction } from '../TransactionModel';
import { TransactionReplayProtector } from '../TransactionReplayProtector';
import { WalletService } from '../WalletService';

describe('CanonicalTransactionRepository', () => {
  it('persists canonical transactions and replay snapshots across repository instances', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    const repository = new CanonicalTransactionRepository(database);
    await repository.initialize();

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
    const replayProtector = new TransactionReplayProtector();
    replayProtector.record(transaction);

    await repository.save(transaction, 1000);
    await repository.saveReplaySnapshot(replayProtector.exportSnapshot(), 1000);

    const reloaded = new CanonicalTransactionRepository(database);
    await reloaded.initialize();

    await expect(reloaded.getById(transaction.id)).resolves.toMatchObject({
      id: transaction.id,
      payloadHash: transaction.payloadHash,
    });

    const importedProtector = new TransactionReplayProtector();
    const snapshot = await reloaded.loadReplaySnapshot();
    expect(snapshot).not.toBeNull();
    if (!snapshot) {
      throw new Error('Expected replay snapshot');
    }
    importedProtector.importSnapshot(snapshot);
    expect(importedProtector.record(transaction)).toEqual({
      accepted: false,
      reason: 'duplicate-id',
    });
  });

  it('allows WalletService to persist replay state before reporting success', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    const repository = new CanonicalTransactionRepository(database);
    await repository.initialize();

    const wallet = new WalletService(createFixedClock(1000), repository);
    await wallet.initialize();
    wallet.createWallet('peer-a');

    await expect(wallet.addBalance(10, 'REWARD')).resolves.toBe(true);

    const transactions = await repository.listAll();
    expect(transactions).toHaveLength(1);
    expect(await repository.loadReplaySnapshot()).toMatchObject({
      processedIds: [transactions[0].id],
    });
  });

  it('restores wallet balance, nonce and visible transactions from canonical storage', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    const repository = new CanonicalTransactionRepository(database);
    await repository.initialize();

    const wallet = new WalletService(createFixedClock(1000), repository);
    await wallet.initialize();
    const created = wallet.createWallet('peer-a');
    await expect(wallet.addBalance(25, 'REWARD')).resolves.toBe(true);

    const reloadedRepository = new CanonicalTransactionRepository(database);
    const reloaded = new WalletService(createFixedClock(5000), reloadedRepository);
    await reloaded.initialize();
    const restored = reloaded.createWallet('peer-a');

    expect(restored.address).toBe(created.address);
    expect(restored.balance).toBe(25);
    expect(restored.nonce).toBe(1);
    expect(reloaded.getTransactions()).toMatchObject([
      {
        amount: 25,
        status: 'CONFIRMED',
        to: created.address,
        type: 'REWARD',
      },
    ]);
  });
});
