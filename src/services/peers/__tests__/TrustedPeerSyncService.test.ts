import { AppError } from '@/errors/AppError';
import { createStorageService, type StorageDriver } from '@/services/storage/StorageService';

import { TrustedPeerRepository } from '../TrustedPeerRepository';
import { TrustedPeerSyncService } from '../TrustedPeerSyncService';

function createMemoryDriver(): StorageDriver {
  const data = new Map<string, string>();
  return {
    getString: (key) => data.get(key) ?? null,
    setString: (key, value) => data.set(key, value),
    remove: (key) => data.delete(key),
    clear: () => data.clear(),
  };
}

describe('TrustedPeerSyncService', () => {
  it('delegates verified peer synchronization to the real remote protocol boundary', async () => {
    const repository = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    repository.upsert({ peerId: 'peer-b', source: 'invite', trustStatus: 'verified' });
    const requestRemoteSync = jest.fn(async () => 4);
    const service = new TrustedPeerSyncService(repository, requestRemoteSync);

    await expect(service.syncPeer('peer-b')).resolves.toBe(4);
    expect(requestRemoteSync).toHaveBeenCalledWith('peer-b');
  });

  it('does not report local objects as synchronized for an unverified peer', async () => {
    const repository = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    repository.upsert({ peerId: 'peer-b', source: 'invite' });
    const requestRemoteSync = jest.fn(async () => 4);
    const service = new TrustedPeerSyncService(repository, requestRemoteSync);

    await expect(service.syncPeer('peer-b')).resolves.toBe(0);
    expect(requestRemoteSync).not.toHaveBeenCalled();
  });

  it('returns a typed retryable network error when remote sync fails', async () => {
    const repository = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    repository.upsert({ peerId: 'peer-b', source: 'invite', trustStatus: 'verified' });
    const service = new TrustedPeerSyncService(repository, async () => {
      throw new Error('channel closed');
    });

    const operation = service.syncPeer('peer-b');

    await expect(operation).rejects.toBeInstanceOf(AppError);
    await expect(operation).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      retryable: true,
    });
  });
});
