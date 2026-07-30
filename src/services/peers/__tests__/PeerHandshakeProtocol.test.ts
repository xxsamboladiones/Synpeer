import { CryptoService } from '@/crypto/CryptoService';
import { InMemoryPeerTransport } from '@/network/PeerTransport';
import type { NetworkService } from '@/services/network/NetworkService';
import { createStorageService, type StorageDriver } from '@/services/storage/StorageService';

import { PeerHandshakeProtocol } from '../PeerHandshakeProtocol';
import { PeerSessionService } from '../PeerSessionService';
import { PeerTrustService } from '../PeerTrustService';
import { TrustedPeerRepository } from '../TrustedPeerRepository';

let mockKeyCounter = 40;

jest.mock('expo-crypto', () => ({
  getRandomBytesAsync: jest.fn(() => {
    mockKeyCounter += 1;
    return Promise.resolve(new Uint8Array(32).map((_, index) => (index + mockKeyCounter) % 256));
  }),
}));

function createMemoryDriver(): StorageDriver {
  const data = new Map<string, string>();
  return {
    getString: (key) => data.get(key) ?? null,
    setString: (key, value) => data.set(key, value),
    remove: (key) => data.delete(key),
    clear: () => data.clear(),
  };
}

function createNetworkService(peerId: string, publicIdentity: string): NetworkService {
  return {
    getLocalIdentity: async () => ({ peerId, publicIdentity, createdAt: 1 }),
    getPeerManager: () => ({ getPeerId: () => peerId }),
  } as unknown as NetworkService;
}

describe('PeerHandshakeProtocol', () => {
  it('verifies two connected peers over PeerTransport and persists session state', async () => {
    const transportA = new InMemoryPeerTransport('peer-a');
    const transportB = new InMemoryPeerTransport('peer-b');
    await transportA.connect(transportB);

    const storageA = createStorageService(createMemoryDriver());
    const storageB = createStorageService(createMemoryDriver());
    const cryptoA = new CryptoService(storageA);
    const cryptoB = new CryptoService(storageB);
    const identityA = await cryptoA.createIdentity();
    const identityB = await cryptoB.createIdentity();
    const repositoryA = new TrustedPeerRepository(storageA);
    const repositoryB = new TrustedPeerRepository(storageB);
    repositoryA.upsert({ peerId: 'peer-b', addresses: [], source: 'invite' });
    repositoryB.upsert({ peerId: 'peer-a', addresses: [], source: 'invite' });

    const trustA = new PeerTrustService(repositoryA, cryptoA, () =>
      createNetworkService('peer-a', identityA),
    );
    const trustB = new PeerTrustService(repositoryB, cryptoB, () =>
      createNetworkService('peer-b', identityB),
    );
    const sessionA = new PeerSessionService(repositoryA);
    const sessionB = new PeerSessionService(repositoryB);
    const protocolA = new PeerHandshakeProtocol(transportA, trustA, sessionA);
    const protocolB = new PeerHandshakeProtocol(transportB, trustB, sessionB);
    protocolA.start();
    protocolB.start();

    await expect(protocolA.handshake('peer-b')).resolves.toBe(true);

    expect(repositoryA.get('peer-b')).toMatchObject({
      trustStatus: 'verified',
      sessionState: 'verified',
      publicKey: identityB,
    });
    expect(repositoryB.get('peer-a')).toMatchObject({
      trustStatus: 'verified',
      sessionState: 'verified',
      publicKey: identityA,
    });

    protocolA.stop();
    protocolB.stop();
  });
});
