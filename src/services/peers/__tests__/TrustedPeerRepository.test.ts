import { createStorageService, type StorageDriver } from '@/services/storage/StorageService';
import { TrustedPeerRepository } from '../TrustedPeerRepository';

function createMemoryDriver(): StorageDriver {
  const data = new Map<string, string>();
  return {
    getString: (key) => data.get(key) ?? null,
    setString: (key, value) => data.set(key, value),
    remove: (key) => data.delete(key),
    clear: () => data.clear(),
  };
}

describe('TrustedPeerRepository', () => {
  it('persists peers and merges duplicate addresses', () => {
    const repository = new TrustedPeerRepository(createStorageService(createMemoryDriver()));

    repository.upsert({ peerId: 'peer-a', addresses: ['/ip4/127.0.0.1/tcp/1'], source: 'invite' });
    repository.upsert({
      peerId: 'peer-a',
      addresses: ['/ip4/127.0.0.1/tcp/1', '/ip4/127.0.0.1/tcp/2'],
    });

    expect(repository.list()).toHaveLength(1);
    expect(repository.get('peer-a')?.addresses).toEqual([
      '/ip4/127.0.0.1/tcp/1',
      '/ip4/127.0.0.1/tcp/2',
    ]);
  });

  it('blocks, unblocks, removes and records sync state', () => {
    const repository = new TrustedPeerRepository(createStorageService(createMemoryDriver()));

    repository.upsert({ peerId: 'peer-a', addresses: [] });
    repository.markBlocked('peer-a');
    expect(repository.get('peer-a')?.trustStatus).toBe('blocked');

    repository.markUnknown('peer-a');
    expect(repository.get('peer-a')?.trustStatus).toBe('unknown');

    repository.recordConnection('peer-a');
    repository.recordSync('peer-a', 3);
    expect(repository.get('peer-a')?.lastConnectedAt).toBeGreaterThan(0);
    expect(repository.get('peer-a')?.syncedObjects).toBe(3);

    repository.remove('peer-a');
    expect(repository.get('peer-a')).toBeNull();
    expect(repository.isRemoved('peer-a')).toBe(true);
  });

  it('keeps a local removed marker until the peer is explicitly restored', () => {
    const storage = createStorageService(createMemoryDriver());
    const repository = new TrustedPeerRepository(storage);

    repository.upsert({ peerId: 'peer-a', addresses: [] });
    repository.remove('peer-a');

    const reloaded = new TrustedPeerRepository(storage);
    expect(reloaded.isRemoved('peer-a')).toBe(true);

    reloaded.forgetRemoved('peer-a');
    expect(reloaded.isRemoved('peer-a')).toBe(false);

    reloaded.upsert({ peerId: 'peer-a', addresses: [] });
    expect(reloaded.get('peer-a')).not.toBeNull();
    expect(reloaded.isRemoved('peer-a')).toBe(false);
  });

  it('clears all trusted peer records', () => {
    const storage = createStorageService(createMemoryDriver());
    const repository = new TrustedPeerRepository(storage);

    repository.upsert({ peerId: 'peer-a', addresses: [] });
    repository.upsert({ peerId: 'peer-b', addresses: [] });
    repository.clear();

    expect(repository.list()).toEqual([]);
    expect(new TrustedPeerRepository(storage).list()).toEqual([]);
  });
});
