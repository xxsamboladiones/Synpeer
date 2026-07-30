import { openDatabaseService } from '@/database/sqliteAdapter.web';
import { createFixedClock } from '@/time/Clock';

import { ConsensusEngine } from '../ConsensusEngine';
import { ConsensusRepository } from '../ConsensusRepository';

describe('ConsensusRepository integration', () => {
  it('persists and restores consensus rounds, votes and quorum history', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    const repository = new ConsensusRepository(database);
    const engine = new ConsensusEngine(createFixedClock(1_000_000), repository);
    await engine.initialize();

    registerPeer(engine, 'witness-a');
    registerPeer(engine, 'witness-b');
    registerPeer(engine, 'witness-c');

    const round = engine.startContributionRound('contribution-1', 'alice', 'VALIDATION', 10);
    round.start();
    expect(round.castVote('witness-a', 'approve')).toBe(true);
    expect(round.castVote('witness-b', 'approve')).toBe(true);
    expect(round.castVote('witness-c', 'approve')).toBe(true);
    await engine.flushPersistence();

    const restored = new ConsensusEngine(createFixedClock(1_001_000), repository);
    await restored.initialize();

    const restoredRound = restored.getRoundByContributionId('contribution-1');
    expect(restoredRound?.getStatus()).toBe('reached');
    expect(restoredRound?.getVoteCounts()).toEqual({
      total: 3,
      approve: 3,
      reject: 0,
      abstain: 0,
    });
    expect(restored.getQuorumManager().getQuorumResult('contribution-1')).toMatchObject({
      reached: true,
      actualPeers: 3,
    });
  });

  it('ignores corrupt consensus snapshots instead of hydrating invalid state', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    const repository = new ConsensusRepository(database);
    await repository.initialize();
    await database.run(
      `
      INSERT OR REPLACE INTO consensus_snapshots
      (id, updatedAt, data)
      VALUES (?, ?, ?);
    `,
      ['local-consensus', 1000, '{corrupt'],
    );

    const engine = new ConsensusEngine(createFixedClock(1000), repository);
    await expect(engine.initialize()).resolves.toBeUndefined();
    expect(engine.getAllRounds()).toHaveLength(0);
  });
});

function registerPeer(engine: ConsensusEngine, peerId: string): void {
  engine.getPeerVerification().registerFingerprint({
    peerId,
    behaviorPattern: `pattern-${peerId}`,
    creationTime: 1,
    firstSeen: 1,
    lastSeen: 1,
    connectionCount: 3,
  });
}
