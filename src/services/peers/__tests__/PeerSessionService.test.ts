import { createStorageService, type StorageDriver } from '@/services/storage/StorageService';

import { PeerSessionService } from '../PeerSessionService';
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

describe('PeerSessionService', () => {
  it('persists verified session state and trust projection', () => {
    const repository = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    const clock = { now: jest.fn(() => 1000) };
    const service = new PeerSessionService(repository, clock);

    const { session, challenge } = service.startHandshake('peer-b', 'peer-a', 'identity-a');
    expect(repository.get('peer-b')?.sessionState).toBe('connecting');

    clock.now.mockReturnValue(2000);
    const verified = service.verifySession(session.sessionId, 'peer-b', challenge);

    expect(verified?.state).toBe('verified');
    expect(repository.get('peer-b')).toMatchObject({
      sessionState: 'verified',
      activeSessionId: session.sessionId,
      projection: {
        trustScore: 100,
        successfulHandshakes: 1,
        failedHandshakes: 0,
      },
    });
  });

  it('records failed handshakes without marking peer verified', () => {
    const repository = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
    const service = new PeerSessionService(repository, { now: () => 1000 });

    const { session } = service.startHandshake('peer-b', 'peer-a', 'identity-a');
    service.failSession(session.sessionId, 'Invalid identity signature');

    expect(repository.get('peer-b')).toMatchObject({
      trustStatus: 'unknown',
      sessionState: 'failed',
      projection: {
        trustScore: 0,
        successfulHandshakes: 0,
        failedHandshakes: 1,
        lastFailureReason: 'Invalid identity signature',
      },
    });
  });
});
