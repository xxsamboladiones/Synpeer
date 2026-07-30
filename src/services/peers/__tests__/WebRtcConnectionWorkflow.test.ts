import { createWebRtcSignalPayload, encodeWebRtcSignal } from '@/network/WebRtcSignaling';
import { createStorageService, type StorageDriver } from '@/services/storage/StorageService';

import {
  WebRtcConnectionWorkflow,
  type WebRtcConnectionRuntime,
} from '../WebRtcConnectionWorkflow';
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

function createSignal(input: {
  type: 'offer' | 'answer';
  sessionId: string;
  peerId: string;
}): string {
  return encodeWebRtcSignal(
    createWebRtcSignalPayload({
      type: input.type,
      sessionId: input.sessionId,
      peerId: input.peerId,
      createdAt: 1000,
      expiresAt: Date.now() + 60_000,
      description: {
        type: input.type,
        sdp: 'v=0',
      },
    }),
  );
}

function createHarness(runtime: WebRtcConnectionRuntime) {
  const repository = new TrustedPeerRepository(createStorageService(createMemoryDriver()));
  const workflow = new WebRtcConnectionWorkflow(repository, () => runtime);
  return { repository, workflow };
}

describe('WebRtcConnectionWorkflow', () => {
  it('creates an offer bound to a trusted peer and marks the session connecting', async () => {
    const createPeerOffer = jest.fn(async () =>
      createSignal({ type: 'offer', sessionId: 'session-1', peerId: 'local-peer' }),
    );
    const runtime: WebRtcConnectionRuntime = {
      isWebRtcAvailable: () => true,
      createPeerOffer,
      getSessions: () => [],
    };
    const { repository, workflow } = createHarness(runtime);
    repository.upsert({ peerId: 'remote-peer', trustStatus: 'unknown' });

    const result = await workflow.createOfferForPeer('remote-peer');

    expect(result.step).toBe('offer-created');
    expect(result.sessionId).toBe('session-1');
    expect(result.remotePeerId).toBe('remote-peer');
    expect(result.code).toContain('synpeer:signal?data=');
    expect(createPeerOffer).toHaveBeenCalledWith('remote-peer');
    expect(repository.get('remote-peer')?.sessionState).toBe('connecting');
    expect(repository.get('remote-peer')?.activeSessionId).toBe('session-1');
  });

  it('starts automatic signaling for a trusted peer without exposing a manual code', async () => {
    const connectToPeer = jest.fn(async () => ({ mode: 'auto-signaling' as const }));
    const runtime: WebRtcConnectionRuntime = {
      isWebRtcAvailable: () => true,
      connectToPeer,
      getSessions: () => [],
    };
    const { repository, workflow } = createHarness(runtime);
    repository.upsert({ peerId: 'remote-peer', trustStatus: 'verified' });

    const result = await workflow.connectPeer('remote-peer');

    expect(connectToPeer).toHaveBeenCalledWith('remote-peer');
    expect(result.step).toBe('auto-connect-started');
    expect(result.code).toBeUndefined();
    expect(repository.get('remote-peer')?.sessionState).toBe('connecting');
  });

  it('falls back to manual offer creation when automatic signaling is unavailable', async () => {
    const runtime: WebRtcConnectionRuntime = {
      isWebRtcAvailable: () => true,
      connectToPeer: async () => ({
        mode: 'manual' as const,
        offerCode: createSignal({
          type: 'offer',
          sessionId: 'session-manual',
          peerId: 'local-peer',
        }),
      }),
      getSessions: () => [],
    };
    const { repository, workflow } = createHarness(runtime);
    repository.upsert({ peerId: 'remote-peer', trustStatus: 'unknown' });

    const result = await workflow.connectPeer('remote-peer');

    expect(result.step).toBe('offer-created');
    expect(result.code).toContain('synpeer:signal?data=');
    expect(repository.get('remote-peer')?.activeSessionId).toBe('session-manual');
  });

  it('imports the offering peer and creates an answer', async () => {
    const offer = createSignal({ type: 'offer', sessionId: 'session-2', peerId: 'peer-a' });
    const runtime: WebRtcConnectionRuntime = {
      isWebRtcAvailable: () => true,
      acceptPeerOffer: async () =>
        createSignal({ type: 'answer', sessionId: 'session-2', peerId: 'local-peer' }),
      getSessions: () => [],
    };
    const { repository, workflow } = createHarness(runtime);

    const result = await workflow.acceptOffer(offer);

    expect(result.step).toBe('answer-created');
    expect(result.remotePeerId).toBe('peer-a');
    expect(repository.get('peer-a')?.trustStatus).toBe('unknown');
    expect(repository.get('peer-a')?.sessionState).toBe('connecting');
    expect(repository.get('peer-a')?.activeSessionId).toBe('session-2');
  });

  it('rejects an answer that does not match a pending local offer', async () => {
    const answer = createSignal({ type: 'answer', sessionId: 'orphan-session', peerId: 'peer-b' });
    const runtime: WebRtcConnectionRuntime = {
      isWebRtcAvailable: () => true,
      applyPeerAnswer: async () => undefined,
      hasPendingPeerOffer: () => false,
      getSessions: () => [],
    };
    const { workflow } = createHarness(runtime);

    await expect(workflow.applyAnswer(answer)).rejects.toThrow(
      'WebRTC answer does not match an active outbound offer',
    );
  });

  it('applies a valid answer and records the remote peer session', async () => {
    const answer = createSignal({ type: 'answer', sessionId: 'session-3', peerId: 'peer-c' });
    const applyPeerAnswer = jest.fn(async () => undefined);
    const runtime: WebRtcConnectionRuntime = {
      isWebRtcAvailable: () => true,
      applyPeerAnswer,
      hasPendingPeerOffer: (sessionId) => sessionId === 'session-3',
      getSessions: () => [],
    };
    const { repository, workflow } = createHarness(runtime);

    const result = await workflow.applyAnswer(answer);

    expect(result.step).toBe('answer-applied');
    expect(applyPeerAnswer).toHaveBeenCalledWith(answer);
    expect(repository.get('peer-c')?.sessionState).toBe('connecting');
    expect(repository.get('peer-c')?.activeSessionId).toBe('session-3');
  });
});
