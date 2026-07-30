import { CryptoService } from '@/crypto/CryptoService';
import type { NetworkService } from '@/services/network/NetworkService';
import { createStorageService, type StorageDriver } from '@/services/storage/StorageService';
import {
  PeerTrustService,
  type LegacyTrustTransport,
  type LegacyTrustTransportMessage,
} from '../PeerTrustService';
import { TrustedPeerRepository } from '../TrustedPeerRepository';

type LegacyTrustResponder = (message: LegacyTrustTransportMessage) => Promise<unknown> | unknown;

class FakeLegacyTrustTransport implements LegacyTrustTransport {
  private readonly handlers = new Set<
    (message: LegacyTrustTransportMessage) => Promise<void> | void
  >();
  private readonly responders = new Set<LegacyTrustResponder>();

  async request<T>(_channel: 'trust', packet: string): Promise<T[]> {
    const message = { packet };
    for (const handler of this.handlers) {
      await handler(message);
    }

    const responses: T[] = [];
    for (const responder of this.responders) {
      const response = await responder(message);
      if (response !== null && response !== undefined) {
        responses.push(response as T);
      }
    }
    return responses;
  }

  subscribe(
    _channel: 'trust',
    handler: (message: LegacyTrustTransportMessage) => Promise<void> | void,
  ): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  respond<T>(
    _channel: 'trust',
    responder: (message: LegacyTrustTransportMessage) => Promise<T | null> | T | null,
  ): () => void {
    this.responders.add(responder);
    return () => this.responders.delete(responder);
  }
}

let mockKeyCounter = 10;

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

describe('PeerTrustService', () => {
  it('verifies a remote identity and marks the peer as trusted', async () => {
    const transport = new FakeLegacyTrustTransport();
    const storageA = createStorageService(createMemoryDriver());
    const storageB = createStorageService(createMemoryDriver());
    const cryptoA = new CryptoService(storageA);
    const cryptoB = new CryptoService(storageB);
    const identityA = await cryptoA.createIdentity();
    const identityB = await cryptoB.createIdentity();
    const repositoryA = new TrustedPeerRepository(storageA);
    const repositoryB = new TrustedPeerRepository(storageB);

    repositoryA.upsert({ peerId: 'peer-b', addresses: ['/ip4/127.0.0.1/tcp/2'], source: 'invite' });

    const trustA = new PeerTrustService(
      repositoryA,
      cryptoA,
      () => createNetworkService('peer-a', identityA),
      transport,
    );
    const trustB = new PeerTrustService(
      repositoryB,
      cryptoB,
      () => createNetworkService('peer-b', identityB),
      transport,
    );
    trustB.start();

    await expect(trustA.handshake('peer-b')).resolves.toBe(true);

    expect(repositoryA.get('peer-b')?.trustStatus).toBe('verified');
    expect(repositoryA.get('peer-b')?.publicKey).toBe(identityB);
    expect(repositoryA.get('peer-b')?.sessionState).toBe('verified');
    expect(repositoryA.get('peer-b')?.projection).toMatchObject({
      trustScore: 100,
      successfulHandshakes: 1,
    });

    trustB.stop();
  });

  it('keeps invalid identities unknown', async () => {
    const storage = createStorageService(createMemoryDriver());
    const crypto = new CryptoService(storage);
    const identity = await crypto.createIdentity();
    const repository = new TrustedPeerRepository(storage);
    const service = new PeerTrustService(
      repository,
      crypto,
      () => createNetworkService('peer-a', identity),
      new FakeLegacyTrustTransport(),
    );

    const valid = await service.verifyIdentity({
      peerId: 'peer-b',
      identityId: identity,
      publicKey: identity,
      timestamp: Date.now(),
      signature: '00',
    });

    expect(valid).toBe(false);
  });
});
