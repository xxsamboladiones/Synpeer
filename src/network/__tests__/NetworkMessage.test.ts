import {
  createNetworkMessage,
  estimateNetworkMessageBytes,
  MAX_NETWORK_MESSAGE_BYTES,
  NetworkMessageDeduplicator,
  validateNetworkMessage,
} from '../NetworkMessage';

describe('NetworkMessage', () => {
  it('creates deterministic message ids for canonical input', () => {
    const first = createNetworkMessage({
      messageType: 'peer.heartbeat',
      senderId: 'peer-a',
      payload: { ok: true },
      timestamp: 1000,
      ttlMs: 5000,
    });
    const second = createNetworkMessage({
      messageType: 'peer.heartbeat',
      senderId: 'peer-a',
      payload: { ok: true },
      timestamp: 1000,
      ttlMs: 5000,
    });

    expect(first.messageId).toBe(second.messageId);
    expect(validateNetworkMessage(first, 1001)).toMatchObject({ valid: true });
  });

  it('rejects expired and incompatible messages', () => {
    const expired = createNetworkMessage({
      messageType: 'sync.request',
      senderId: 'peer-a',
      payload: {},
      timestamp: 1000,
      ttlMs: 10,
    });

    expect(validateNetworkMessage(expired, 2000)).toEqual({
      valid: false,
      error: 'Message expired',
    });
    expect(validateNetworkMessage({ ...expired, protocolVersion: 999 }, 1001)).toEqual({
      valid: false,
      error: 'Unsupported protocol version',
    });
  });

  it('deduplicates message ids until they expire', () => {
    const message = createNetworkMessage({
      messageType: 'media.chunk.request',
      senderId: 'peer-a',
      payload: { chunkId: 'chunk-a' },
      timestamp: 1000,
      ttlMs: 100,
    });
    const deduplicator = new NetworkMessageDeduplicator();

    expect(deduplicator.accept(message, 1000)).toBe(true);
    expect(deduplicator.accept(message, 1001)).toBe(false);
    expect(deduplicator.accept(message, 1200)).toBe(true);
  });

  it('accepts the versioned incremental sync refresh hint', () => {
    const message = createNetworkMessage({
      messageType: 'sync.hint',
      senderId: 'peer-a',
      timestamp: 100,
      ttlMs: 1000,
      payload: {
        version: 1,
        type: 'sync.refresh.hint',
        changedAt: 100,
      },
    });

    expect(validateNetworkMessage(message, 200)).toEqual({
      valid: true,
      message,
    });
  });

  it('measures the serialized protocol limit in UTF-8 bytes', () => {
    const message = createNetworkMessage({
      messageType: 'social.post',
      senderId: 'peer-a',
      timestamp: 100,
      ttlMs: 1000,
      payload: { text: 'á'.repeat(MAX_NETWORK_MESSAGE_BYTES / 2) },
    });

    expect(JSON.stringify(message).length).toBeLessThan(MAX_NETWORK_MESSAGE_BYTES);
    expect(estimateNetworkMessageBytes(message)).toBeGreaterThan(MAX_NETWORK_MESSAGE_BYTES);
    expect(validateNetworkMessage(message, 200)).toEqual({
      valid: false,
      error: 'Message exceeds size limit',
    });
  });
});
