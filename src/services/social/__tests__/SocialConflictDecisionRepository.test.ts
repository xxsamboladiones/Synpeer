import { openDatabaseService } from '@/database/sqliteAdapter.web';

import { SocialConflictDecisionRepository } from '../SocialConflictDecisionRepository';

describe('SocialConflictDecisionRepository', () => {
  it('persists only deterministic decision metadata and restores it', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    const repository = new SocialConflictDecisionRepository(database);

    const decision = await repository.record({
      entity: 'post',
      entityId: 'post-1',
      localStateHash: 'a'.repeat(64),
      incomingStateHash: 'b'.repeat(64),
      resolution: {
        action: 'apply',
        reason: 'canonical_hash_wins',
        winnerStateHash: 'b'.repeat(64),
        conflict: true,
      },
      decidedAt: 1_000,
    });

    await expect(repository.list('post-1')).resolves.toEqual([decision]);
    const persisted = await database.query('SELECT * FROM social_conflict_decisions;');
    expect(JSON.stringify(persisted)).not.toContain('text');
    expect(JSON.stringify(persisted)).not.toContain('payload');
  });

  it('is idempotent for the same conflict and clears all audit decisions', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    const repository = new SocialConflictDecisionRepository(database);
    const input = {
      entity: 'profile' as const,
      entityId: 'profile-peer-a',
      incomingStateHash: 'c'.repeat(64),
      resolution: {
        action: 'keep' as const,
        reason: 'canonical_hash_loses' as const,
        winnerStateHash: 'd'.repeat(64),
        conflict: true,
      },
    };

    const first = await repository.record({ ...input, decidedAt: 1_000 });
    const repeated = await repository.record({ ...input, decidedAt: 2_000 });

    expect(repeated.id).toBe(first.id);
    await expect(repository.list()).resolves.toHaveLength(1);
    await repository.clear();
    await expect(repository.list()).resolves.toEqual([]);
  });

  it('rejects corrupt persisted decisions', async () => {
    const database = await openDatabaseService({ forceMemory: true });
    const repository = new SocialConflictDecisionRepository(database);
    await database.run(
      `
      INSERT OR REPLACE INTO social_conflict_decisions
      (id, entity, entityId, localStateHash, incomingStateHash, winnerStateHash, action, reason, peerId, decidedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      [
        'broken',
        'not-an-entity',
        'post-1',
        null,
        'incoming',
        'winner',
        'apply',
        'no_local_record',
        null,
        1_000,
      ],
    );

    await expect(repository.list()).rejects.toThrow('Stored social conflict decision is corrupt');
  });
});
