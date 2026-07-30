import {
  createWebRtcSignalPayload,
  createWebRtcSessionId,
  decodeWebRtcSignal,
  defaultPeerCapabilities,
  encodeWebRtcSignal,
} from '../WebRtcSignaling';

describe('WebRtcSignaling', () => {
  it('encodes and decodes a valid offer payload', () => {
    const payload = createWebRtcSignalPayload({
      type: 'offer',
      sessionId: createWebRtcSessionId('peer-a', 1000),
      peerId: 'peer-a',
      createdAt: 1000,
      expiresAt: 2000,
      description: {
        type: 'offer',
        sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1',
      },
      capabilities: defaultPeerCapabilities,
    });

    const code = encodeWebRtcSignal(payload);

    expect(decodeWebRtcSignal(code, 1500)).toEqual(payload);
  });

  it('rejects expired signaling payloads', () => {
    const payload = createWebRtcSignalPayload({
      type: 'answer',
      sessionId: 'session-1',
      peerId: 'peer-b',
      createdAt: 1000,
      expiresAt: 1100,
      description: {
        type: 'answer',
        sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1',
      },
    });

    expect(() => decodeWebRtcSignal(encodeWebRtcSignal(payload), 1200)).toThrow(
      'Signaling payload expired',
    );
  });

  it('rejects malformed payloads', () => {
    expect(() => decodeWebRtcSignal('not-json')).toThrow('Invalid signaling payload');
  });

  it('accepts signal codes copied with line breaks', () => {
    const payload = createWebRtcSignalPayload({
      type: 'answer',
      sessionId: 'session-1',
      peerId: 'peer-b',
      createdAt: 1000,
      expiresAt: 2000,
      description: {
        type: 'answer',
        sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1',
      },
    });
    const code = encodeWebRtcSignal(payload);
    const wrapped = `${code.slice(0, 32)}\n${code.slice(32, 72)} ${code.slice(72)}`;

    expect(decodeWebRtcSignal(wrapped, 1500)).toEqual(payload);
  });

  it('accepts url-like signal codes', () => {
    const payload = createWebRtcSignalPayload({
      type: 'offer',
      sessionId: 'session-1',
      peerId: 'peer-a',
      createdAt: 1000,
      expiresAt: 2000,
      description: {
        type: 'offer',
        sdp: 'v=0',
      },
    });
    const code = encodeWebRtcSignal(payload).replace('synpeer:signal?', 'synpeer://signal?');

    expect(decodeWebRtcSignal(code, 1500)).toEqual(payload);
  });

  it('continues to decode legacy signaling links', () => {
    const payload = createWebRtcSignalPayload({
      type: 'offer',
      sessionId: 'legacy-session',
      peerId: 'peer-a',
      createdAt: 1000,
      expiresAt: 2000,
      description: {
        type: 'offer',
        sdp: 'v=0',
      },
    });
    const current = encodeWebRtcSignal(payload);

    expect(decodeWebRtcSignal(current.replace('synpeer:signal?', 'insta99:signal?'), 1500)).toEqual(
      payload,
    );
    expect(
      decodeWebRtcSignal(current.replace('synpeer:signal?', 'insta99://signal?'), 1500),
    ).toEqual(payload);
  });

  it('rejects tampered checksums', () => {
    const payload = createWebRtcSignalPayload({
      type: 'offer',
      sessionId: 'session-1',
      peerId: 'peer-a',
      createdAt: 1000,
      expiresAt: 2000,
      description: {
        type: 'offer',
        sdp: 'v=0',
      },
    });
    const tampered = {
      ...payload,
      peerId: 'peer-c',
    };

    expect(() => decodeWebRtcSignal(encodeURIComponent(JSON.stringify(tampered)), 1500)).toThrow(
      'Signaling checksum mismatch',
    );
  });
});
