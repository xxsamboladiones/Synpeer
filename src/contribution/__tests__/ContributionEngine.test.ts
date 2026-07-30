import { ContributionEngine } from '../ContributionEngine';

describe('ContributionEngine', () => {
  it('does not count duplicate contribution events twice', () => {
    const engine = new ContributionEngine();

    engine.emitEvent('CHUNK_SERVED', 'peer-a', 1, { chunkId: 'chunk-1' });
    engine.emitEvent('CHUNK_SERVED', 'peer-a', 1, { chunkId: 'chunk-1' });

    expect(engine.getMetrics('peer-a').chunksServed).toBe(1);
    expect(engine.getLedgerEntries('peer-a')).toHaveLength(1);
  });
});
