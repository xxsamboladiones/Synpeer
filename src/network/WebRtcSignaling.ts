import { AppError } from '@/errors/AppError';
import type { PeerId } from '@/network/NetworkTypes';
import { sha256Hex } from '@/utils/hash';
import { LEGACY_URI_SCHEME, URI_SCHEME } from '@/constants/Brand';

export type WebRtcSignalType = 'offer' | 'answer';

export interface PeerCapabilities {
  protocolVersions: number[];
  sync: {
    posts: boolean;
    profiles: boolean;
    media: boolean;
    comments: boolean;
    reactions: boolean;
  };
  compression: string[];
  maxMessageSize: number;
}

export interface WebRtcSignalPayload {
  version: 1;
  type: WebRtcSignalType;
  sessionId: string;
  peerId: PeerId;
  createdAt: number;
  expiresAt: number;
  description: {
    type: 'offer' | 'answer';
    sdp: string;
  };
  capabilities: PeerCapabilities;
  checksum: string;
}

const SIGNAL_PREFIX = `${URI_SCHEME}:signal?data=`;
const SIGNAL_URL_PREFIX = `${URI_SCHEME}://signal?data=`;
const LEGACY_SIGNAL_PREFIX = `${LEGACY_URI_SCHEME}:signal?data=`;
const LEGACY_SIGNAL_URL_PREFIX = `${LEGACY_URI_SCHEME}://signal?data=`;
const SIGNAL_TTL_MS = 10 * 60 * 1000;
const MAX_SIGNAL_BYTES = 128 * 1024;
let sessionCounter = 0;

export const defaultPeerCapabilities: PeerCapabilities = {
  protocolVersions: [1],
  sync: {
    posts: true,
    profiles: true,
    media: false,
    comments: false,
    reactions: false,
  },
  compression: [],
  maxMessageSize: 256 * 1024,
};

export function createWebRtcSessionId(peerId: PeerId, now = Date.now()): string {
  sessionCounter += 1;
  const cryptoScope = globalThis as {
    crypto?: { getRandomValues<T extends Uint8Array>(array: T): T };
  };
  const nonce = new Uint8Array(16);
  if (cryptoScope.crypto?.getRandomValues) {
    cryptoScope.crypto.getRandomValues(nonce);
  }
  return `rtc_${sha256Hex(`${peerId}:${now}:${sessionCounter}:${Array.from(nonce).join('.')}`).slice(0, 32)}`;
}

export function createWebRtcSignalPayload(input: {
  type: WebRtcSignalType;
  sessionId: string;
  peerId: PeerId;
  description: WebRtcSignalPayload['description'];
  capabilities?: PeerCapabilities;
  createdAt?: number;
  expiresAt?: number;
}): WebRtcSignalPayload {
  const createdAt = input.createdAt ?? Date.now();
  const expiresAt = input.expiresAt ?? createdAt + SIGNAL_TTL_MS;
  const unsigned = {
    version: 1,
    type: input.type,
    sessionId: input.sessionId,
    peerId: input.peerId,
    createdAt,
    expiresAt,
    description: input.description,
    capabilities: input.capabilities ?? defaultPeerCapabilities,
  } satisfies Omit<WebRtcSignalPayload, 'checksum'>;

  return {
    ...unsigned,
    checksum: sha256Hex(JSON.stringify(unsigned)),
  };
}

export function encodeWebRtcSignal(payload: WebRtcSignalPayload): string {
  validateWebRtcSignalPayload(payload);
  const serialized = JSON.stringify(payload);
  if (serialized.length > MAX_SIGNAL_BYTES) {
    throw signalingError('Signaling payload exceeds size limit', 'serialize');
  }
  return `${SIGNAL_PREFIX}${encodeURIComponent(serialized)}`;
}

export function decodeWebRtcSignal(code: string, now = Date.now()): WebRtcSignalPayload {
  const encoded = extractEncodedSignalPayload(code);
  let parsed: unknown;
  try {
    const decoded = encoded.startsWith('{') ? encoded : decodeURIComponent(encoded);
    if (decoded.length > MAX_SIGNAL_BYTES) {
      throw signalingError('Signaling payload exceeds size limit', 'parse');
    }
    parsed = JSON.parse(decoded);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw signalingError('Invalid signaling payload', 'parse', error);
  }

  const payload = validateWebRtcSignalPayload(parsed);
  if (payload.expiresAt < now) {
    throw signalingError('Signaling payload expired', 'parse');
  }
  return payload;
}

function extractEncodedSignalPayload(code: string): string {
  const trimmed = code.trim();
  const payload = trimmed.startsWith(SIGNAL_PREFIX)
    ? trimmed.slice(SIGNAL_PREFIX.length)
    : trimmed.startsWith(SIGNAL_URL_PREFIX)
      ? trimmed.slice(SIGNAL_URL_PREFIX.length)
      : trimmed.startsWith(LEGACY_SIGNAL_PREFIX)
        ? trimmed.slice(LEGACY_SIGNAL_PREFIX.length)
        : trimmed.startsWith(LEGACY_SIGNAL_URL_PREFIX)
          ? trimmed.slice(LEGACY_SIGNAL_URL_PREFIX.length)
          : trimmed;

  return payload.startsWith('{') ? payload : payload.replace(/\s+/g, '');
}

export function validateWebRtcSignalPayload(value: unknown): WebRtcSignalPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw signalingError('Signaling payload must be an object', 'validate');
  }
  const payload = value as Record<string, unknown>;
  const description = payload.description as Record<string, unknown> | undefined;
  const capabilities = payload.capabilities;
  if (
    payload.version !== 1 ||
    (payload.type !== 'offer' && payload.type !== 'answer') ||
    typeof payload.sessionId !== 'string' ||
    typeof payload.peerId !== 'string' ||
    typeof payload.createdAt !== 'number' ||
    typeof payload.expiresAt !== 'number' ||
    typeof payload.checksum !== 'string' ||
    !description ||
    (description.type !== 'offer' && description.type !== 'answer') ||
    typeof description.sdp !== 'string' ||
    !isPeerCapabilities(capabilities)
  ) {
    throw signalingError('Malformed signaling payload', 'validate');
  }

  const unsigned = {
    version: 1,
    type: payload.type,
    sessionId: payload.sessionId,
    peerId: payload.peerId,
    createdAt: payload.createdAt,
    expiresAt: payload.expiresAt,
    description: {
      type: description.type,
      sdp: description.sdp,
    },
    capabilities,
  };
  if (sha256Hex(JSON.stringify(unsigned)) !== payload.checksum) {
    throw signalingError('Signaling checksum mismatch', 'validate');
  }

  return { ...unsigned, checksum: payload.checksum } as WebRtcSignalPayload;
}

function isPeerCapabilities(value: unknown): value is PeerCapabilities {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const capabilities = value as Record<string, unknown>;
  const sync = capabilities.sync as Record<string, unknown> | undefined;
  if (!sync) {
    return false;
  }
  return (
    Array.isArray(capabilities.protocolVersions) &&
    capabilities.protocolVersions.every((item) => typeof item === 'number') &&
    Boolean(sync) &&
    typeof sync.posts === 'boolean' &&
    typeof sync.profiles === 'boolean' &&
    typeof sync.media === 'boolean' &&
    typeof sync.comments === 'boolean' &&
    typeof sync.reactions === 'boolean' &&
    Array.isArray(capabilities.compression) &&
    capabilities.compression.every((item) => typeof item === 'string') &&
    typeof capabilities.maxMessageSize === 'number'
  );
}

function signalingError(message: string, operation: string, cause?: unknown): AppError {
  return new AppError({
    code: 'NETWORK_ERROR',
    message,
    safeMessage: 'O codigo de pareamento P2P e invalido ou expirou.',
    severity: 'warning',
    retryable: operation !== 'validate',
    cause,
    context: {
      scope: 'webrtc.signaling',
      operation,
    },
  });
}
