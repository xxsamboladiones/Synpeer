import { createStorageService, type StorageDriver } from '@/services/storage/StorageService';
import type { NetworkService } from '@/services/network/NetworkService';
import { PeerInviteService } from '../PeerInviteService';
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

function createNetworkService(): NetworkService {
  return {
    getLocalIdentity: async () => ({
      peerId: 'local-peer',
      publicIdentity: 'identity-local',
      createdAt: 1,
    }),
    getPeerManager: () => ({ getPeerId: () => 'local-peer' }),
    getListenAddresses: () => ['/ip4/127.0.0.1/tcp/4001/p2p/local-peer'],
  } as unknown as NetworkService;
}

describe('PeerInviteService', () => {
  it('creates and parses a valid invite URI', async () => {
    const repository = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    const service = new PeerInviteService(repository, createNetworkService, () => 'local-peer');

    const invite = await service.createInvite();
    const parsed = service.parseInvite(invite);

    expect(invite.startsWith('synpeer:peer?')).toBe(true);
    expect(parsed.peerId).toBe('local-peer');
    expect(parsed.expiresAt).toBeGreaterThan(parsed.createdAt);
    expect(parsed.nonce).toHaveLength(32);
    expect(parsed.addresses).toEqual(['/ip4/127.0.0.1/tcp/4001/p2p/local-peer']);
  });

  it('imports peers without duplication and rejects the local peer', () => {
    const repository = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    const service = new PeerInviteService(repository, createNetworkService, () => 'local-peer');

    service.importInvite('synpeer:peer?v=1&peerId=remote-peer&addr=%2Fip4%2F1.1.1.1%2Ftcp%2F1');
    service.importInvite(
      'synpeer:peer?v=1&peerId=remote-peer&addr=%2Fip4%2F1.1.1.1%2Ftcp%2F1&addr=%2Fip4%2F2.2.2.2%2Ftcp%2F2',
    );

    expect(repository.list()).toHaveLength(1);
    expect(repository.get('remote-peer')?.addresses).toEqual([
      '/ip4/1.1.1.1/tcp/1',
      '/ip4/2.2.2.2/tcp/2',
    ]);
    expect(() => service.importInvite('synpeer:peer?v=1&peerId=local-peer')).toThrow(
      'Cannot import your own peer invite',
    );
  });

  it('continues to import legacy peer invites', () => {
    const repository = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    const service = new PeerInviteService(repository, createNetworkService, () => 'local-peer');

    const invite = service.importInvite('insta99:peer?v=1&peerId=legacy-peer');

    expect(invite.peerId).toBe('legacy-peer');
  });

  it('rejects invalid invites', () => {
    const repository = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    const service = new PeerInviteService(repository, createNetworkService, () => 'local-peer');

    expect(() => service.parseInvite('https://example.com')).toThrow('Invalid Synpeer peer invite');
    expect(() => service.parseInvite('synpeer:peer?v=9&peerId=a')).toThrow(
      'Unsupported peer invite version',
    );
    expect(() => service.parseInvite('synpeer:peer?v=1')).toThrow('Invite is missing peer id');
    expect(() =>
      service.parseInvite('synpeer:peer?v=1&peerId=a&createdAt=100&expiresAt=101'),
    ).toThrow('Peer invite has expired');
  });
});
