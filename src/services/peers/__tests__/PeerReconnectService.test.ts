import type { NetworkService } from '@/services/network/NetworkService';
import { createStorageService, type StorageDriver } from '@/services/storage/StorageService';

import { PeerReconnectService } from '../PeerReconnectService';
import { TrustedPeerRepository } from '../TrustedPeerRepository';
import type { TrustedPeerSyncService } from '../TrustedPeerSyncService';

function createMemoryDriver(): StorageDriver {
  const data = new Map<string, string>();
  return {
    getString: (key) => data.get(key) ?? null,
    setString: (key, value) => data.set(key, value),
    remove: (key) => data.delete(key),
    clear: () => data.clear(),
  };
}

function createSyncService(): TrustedPeerSyncService {
  return {
    syncPeer: jest.fn(async () => ({ syncedObjects: 0 })),
  } as unknown as TrustedPeerSyncService;
}

describe('PeerReconnectService', () => {
  it('does not auto-dial peers when the runtime requires manual signaling', async () => {
    const repository = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    repository.upsert({
      peerId: 'peer-a',
      addresses: ['webrtc:manual-signaling'],
      trustStatus: 'verified',
    });
    const connectToPeerAddress = jest.fn();
    const networkService = {
      canConnectToPeerAddress: () => true,
      canAutoReconnectToPeerAddress: () => false,
      connectToPeerAddress,
    } as unknown as NetworkService;
    const service = new PeerReconnectService(repository, () => networkService, createSyncService());

    await service.reconnectTrustedPeers();

    expect(connectToPeerAddress).not.toHaveBeenCalled();
    expect(repository.get('peer-a')?.lastConnectedAt).toBeUndefined();
  });

  it('auto-dials saved addresses when the runtime supports it', async () => {
    const repository = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    repository.upsert({
      peerId: 'peer-a',
      addresses: ['/ip4/127.0.0.1/tcp/4001/p2p/peer-a'],
      trustStatus: 'unknown',
    });
    const connectToPeerAddress = jest.fn(async () => undefined);
    const networkService = {
      canConnectToPeerAddress: () => true,
      canAutoReconnectToPeerAddress: () => true,
      connectToPeerAddress,
    } as unknown as NetworkService;
    const service = new PeerReconnectService(repository, () => networkService, createSyncService());

    await service.reconnectTrustedPeers();

    expect(connectToPeerAddress).toHaveBeenCalledWith('/ip4/127.0.0.1/tcp/4001/p2p/peer-a');
    expect(repository.get('peer-a')?.lastConnectedAt).toEqual(expect.any(Number));
  });

  it('ignores manual WebRTC placeholder addresses even when auto-dial is supported', async () => {
    const repository = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    repository.upsert({
      peerId: 'peer-a',
      addresses: ['webrtc:manual-signaling', '/ip4/127.0.0.1/tcp/4001/p2p/peer-a'],
      trustStatus: 'unknown',
    });
    const connectToPeerAddress = jest.fn(async () => undefined);
    const networkService = {
      canConnectToPeerAddress: () => true,
      canAutoReconnectToPeerAddress: () => true,
      connectToPeerAddress,
    } as unknown as NetworkService;
    const service = new PeerReconnectService(repository, () => networkService, createSyncService());

    await service.reconnectTrustedPeers();

    expect(connectToPeerAddress).toHaveBeenCalledTimes(1);
    expect(connectToPeerAddress).toHaveBeenCalledWith('/ip4/127.0.0.1/tcp/4001/p2p/peer-a');
  });

  it('reconnects verified peers through automatic signaling when no dialable address exists', async () => {
    const repository = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    repository.upsert({
      peerId: 'peer-a',
      trustStatus: 'verified',
    });
    const connectToPeer = jest.fn(async () => ({ mode: 'auto-signaling' }));
    const networkService = {
      canConnectToPeerAddress: () => true,
      canAutoReconnectToPeerAddress: () => false,
      canAutoConnectToPeer: () => true,
      connectToPeerAddress: jest.fn(),
      connectToPeer,
      getConnectedPeers: () => [],
    } as unknown as NetworkService;
    const service = new PeerReconnectService(repository, () => networkService, createSyncService());

    await service.reconnectTrustedPeers();

    expect(connectToPeer).toHaveBeenCalledWith('peer-a');
    expect(repository.get('peer-a')?.sessionState).toBe('connecting');
  });

  it('does not create another signaling offer while a reconnect is already pending', async () => {
    const repository = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    repository.upsert({
      peerId: 'peer-a',
      trustStatus: 'verified',
    });
    repository.updateSessionState('peer-a', 'connecting');
    const connectToPeer = jest.fn(async () => ({ mode: 'auto-signaling' }));
    const networkService = {
      canConnectToPeerAddress: () => true,
      canAutoReconnectToPeerAddress: () => false,
      canAutoConnectToPeer: () => true,
      connectToPeerAddress: jest.fn(),
      connectToPeer,
      getConnectedPeers: () => [],
    } as unknown as NetworkService;
    const service = new PeerReconnectService(repository, () => networkService, createSyncService());

    await service.reconnectTrustedPeers();

    expect(connectToPeer).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent automatic signaling reconnect attempts for the same peer', async () => {
    const repository = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    repository.upsert({
      peerId: 'peer-a',
      trustStatus: 'verified',
    });
    let resolveConnect: () => void = () => undefined;
    const connectToPeer = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveConnect = () => resolve({ mode: 'auto-signaling' });
        }),
    );
    const networkService = {
      canConnectToPeerAddress: () => true,
      canAutoReconnectToPeerAddress: () => false,
      canAutoConnectToPeer: () => true,
      connectToPeerAddress: jest.fn(),
      connectToPeer,
      getConnectedPeers: () => [],
    } as unknown as NetworkService;
    const service = new PeerReconnectService(repository, () => networkService, createSyncService());

    const first = service.reconnectTrustedPeers();
    const second = service.reconnectTrustedPeers();
    await Promise.resolve();
    resolveConnect?.();
    await Promise.all([first, second]);

    expect(connectToPeer).toHaveBeenCalledTimes(1);
  });

  it('restores only verified disconnected peers through the session coordinator', async () => {
    const repository = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    repository.upsert({
      peerId: 'peer-verified',
      trustStatus: 'verified',
    });
    repository.upsert({
      peerId: 'peer-unknown',
      trustStatus: 'unknown',
    });
    repository.upsert({
      peerId: 'peer-connected',
      trustStatus: 'verified',
    });
    repository.upsert({
      peerId: 'peer-stale-connecting',
      trustStatus: 'verified',
    });
    repository.updateSessionState('peer-stale-connecting', 'connecting');
    const requestPeerReconnect = jest.fn(() => true);
    const networkService = {
      canConnectToPeerAddress: () => true,
      canAutoConnectToPeer: () => true,
      getConnectedPeers: () => ['peer-connected'],
      requestPeerReconnect,
    } as unknown as NetworkService;
    const service = new PeerReconnectService(repository, () => networkService, createSyncService());

    await service.reconnectTrustedPeers();

    expect(requestPeerReconnect).toHaveBeenCalledTimes(2);
    expect(requestPeerReconnect).toHaveBeenCalledWith('peer-verified', 'startup-restore', true);
    expect(requestPeerReconnect).toHaveBeenCalledWith(
      'peer-stale-connecting',
      'startup-restore',
      true,
    );
  });
});
