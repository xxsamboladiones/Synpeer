import { ConsensusEngine } from '@/consensus/ConsensusEngine';
import { CryptoService } from '@/crypto/CryptoService';
import { InMemoryPeerTransport } from '@/network/PeerTransport';
import { TrustedPeerRepository } from '@/services/peers/TrustedPeerRepository';
import { createStorageService, type StorageDriver } from '@/services/storage/StorageService';

import { PeerConsensusProtocol } from '../PeerConsensusProtocol';
import { getConsensusVoteSignableBytes } from '../ConsensusVoteCrypto';

let mockKeyCounter = 120;

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

function createTrustedRepository(peerId: string, publicKey: string): TrustedPeerRepository {
  const repository = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
  repository.upsert({
    peerId,
    addresses: [],
    source: 'invite',
    trustStatus: 'verified',
    identityId: publicKey,
    publicKey,
  });
  return repository;
}

async function createPeerCrypto(): Promise<{ crypto: CryptoService; publicKey: string }> {
  const crypto = new CryptoService(createStorageService(createMemoryDriver()));
  const publicKey = await crypto.createIdentity();
  return { crypto, publicKey };
}

describe('PeerConsensusProtocol', () => {
  beforeEach(() => {
    mockKeyCounter = 120;
  });

  it('replicates a proposal and records a verified remote vote', async () => {
    const transportA = new InMemoryPeerTransport('peer-a');
    const transportB = new InMemoryPeerTransport('peer-b');
    await transportA.connect(transportB);

    const engineA = new ConsensusEngine();
    const engineB = new ConsensusEngine();
    const peerA = await createPeerCrypto();
    const peerB = await createPeerCrypto();
    const trustedA = createTrustedRepository('peer-b', peerB.publicKey);
    const trustedB = createTrustedRepository('peer-a', peerA.publicKey);
    const protocolA = new PeerConsensusProtocol(
      'peer-a',
      transportA,
      engineA,
      trustedA,
      peerA.crypto,
    );
    const protocolB = new PeerConsensusProtocol(
      'peer-b',
      transportB,
      engineB,
      trustedB,
      peerB.crypto,
    );
    protocolA.start();
    protocolB.start();

    const roundId = await protocolA.proposeContribution({
      contributionId: 'contribution-1',
      contributor: 'peer-a',
      type: 'VALIDATION',
      value: 10,
      targetPeerIds: ['peer-b'],
    });

    expect(engineA.getRound(roundId)?.getVoteCounts()).toMatchObject({
      total: 1,
      approve: 1,
    });
    expect(engineB.getRound(roundId)?.getVoteCounts()).toMatchObject({
      total: 1,
      approve: 1,
    });

    protocolA.stop();
    protocolB.stop();
  });

  it('rejects tampered consensus votes before they reach the engine', async () => {
    const transportA = new InMemoryPeerTransport('peer-a');
    const transportB = new InMemoryPeerTransport('peer-b');
    await transportA.connect(transportB);

    const engineA = new ConsensusEngine();
    const engineB = new ConsensusEngine();
    const peerA = await createPeerCrypto();
    const peerB = await createPeerCrypto();
    const trustedA = createTrustedRepository('peer-b', peerB.publicKey);
    const trustedB = createTrustedRepository('peer-a', peerA.publicKey);
    const protocolA = new PeerConsensusProtocol(
      'peer-a',
      transportA,
      engineA,
      trustedA,
      peerA.crypto,
    );
    const protocolB = new PeerConsensusProtocol(
      'peer-b',
      transportB,
      engineB,
      trustedB,
      peerB.crypto,
    );
    protocolA.start();
    protocolB.start();

    const roundId = await protocolA.proposeContribution({
      contributionId: 'contribution-tampered',
      contributor: 'peer-a',
      type: 'VALIDATION',
      value: 10,
      targetPeerIds: [],
    });
    const votedAt = Date.now();
    const signature = await peerB.crypto.sign(
      getConsensusVoteSignableBytes({
        roundId,
        contributionId: 'contribution-tampered',
        voter: 'peer-b',
        vote: 'approve',
        votedAt,
      }),
    );

    await transportB.getConnection('peer-a')?.send('consensus.vote', {
      version: 1,
      type: 'consensus.vote',
      roundId,
      contributionId: 'contribution-tampered',
      voter: 'peer-b',
      vote: 'reject',
      publicKey: peerB.publicKey,
      signature,
      votedAt,
    });

    expect(engineA.getRound(roundId)?.getVoteCounts()).toMatchObject({
      total: 0,
      reject: 0,
    });

    protocolA.stop();
    protocolB.stop();
  });

  it('propagates a reached consensus result to verified peers', async () => {
    const transportA = new InMemoryPeerTransport('peer-a');
    const transportB = new InMemoryPeerTransport('peer-b');
    await transportA.connect(transportB);

    const engineA = new ConsensusEngine();
    const engineB = new ConsensusEngine();
    engineA.getQuorumManager().updateRequirements({
      minPeers: 1,
      requiredAgreement: 0.5,
      minTrustScore: 0,
      timeout: 300000,
    });
    const peerA = await createPeerCrypto();
    const peerB = await createPeerCrypto();
    const trustedA = createTrustedRepository('peer-b', peerB.publicKey);
    const trustedB = createTrustedRepository('peer-a', peerA.publicKey);
    const protocolA = new PeerConsensusProtocol(
      'peer-a',
      transportA,
      engineA,
      trustedA,
      peerA.crypto,
    );
    const protocolB = new PeerConsensusProtocol(
      'peer-b',
      transportB,
      engineB,
      trustedB,
      peerB.crypto,
    );
    protocolA.start();
    protocolB.start();

    const roundId = await protocolA.proposeContribution({
      contributionId: 'contribution-result',
      contributor: 'peer-a',
      type: 'VALIDATION',
      value: 10,
      targetPeerIds: ['peer-b'],
    });

    expect(engineA.getRound(roundId)?.getRound()).toMatchObject({
      status: 'reached',
      result: 'approved',
    });
    expect(engineB.getRound(roundId)?.getRound()).toMatchObject({
      status: 'reached',
      result: 'approved',
    });

    protocolA.stop();
    protocolB.stop();
  });

  it('does not process consensus messages from unknown peers', async () => {
    const transportA = new InMemoryPeerTransport('peer-a');
    const transportB = new InMemoryPeerTransport('peer-b');
    await transportA.connect(transportB);

    const engineA = new ConsensusEngine();
    const engineB = new ConsensusEngine();
    const peerA = await createPeerCrypto();
    const peerB = await createPeerCrypto();
    const protocolA = new PeerConsensusProtocol(
      'peer-a',
      transportA,
      engineA,
      new TrustedPeerRepository(createStorageService(createMemoryDriver())),
      peerA.crypto,
    );
    const protocolB = new PeerConsensusProtocol(
      'peer-b',
      transportB,
      engineB,
      new TrustedPeerRepository(createStorageService(createMemoryDriver())),
      peerB.crypto,
    );
    protocolA.start();
    protocolB.start();

    await protocolA.proposeContribution({
      contributionId: 'contribution-1',
      contributor: 'peer-a',
      type: 'VALIDATION',
      value: 10,
      targetPeerIds: ['peer-b'],
    });

    expect(engineB.getAllRounds()).toHaveLength(0);

    protocolA.stop();
    protocolB.stop();
  });
});
