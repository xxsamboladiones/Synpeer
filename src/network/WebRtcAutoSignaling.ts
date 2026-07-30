import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';

import { AppError } from '@/errors/AppError';
import type { PeerId } from '@/network/NetworkTypes';
import { createLogger, type Logger } from '@/observability/Logger';
import { sha256Hex } from '@/utils/hash';
import { LEGACY_URI_SCHEME, URI_SCHEME } from '@/constants/Brand';

import type { WebRtcSignalType } from './WebRtcSignaling';

declare const process:
  | {
      env: {
        EXPO_PUBLIC_SUPABASE_URL?: string;
        EXPO_PUBLIC_SUPABASE_ANON_KEY?: string;
      };
    }
  | undefined;

const BUNDLED_SUPABASE_URL =
  typeof process !== 'undefined' ? process.env.EXPO_PUBLIC_SUPABASE_URL : undefined;
const BUNDLED_SUPABASE_ANON_KEY =
  typeof process !== 'undefined' ? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY : undefined;

export type WebRtcAutoSignalType = WebRtcSignalType;

export interface WebRtcAutoSignalMessage {
  version: 1;
  id: string;
  type: WebRtcAutoSignalType;
  fromPeerId: PeerId;
  toPeerId: PeerId;
  code: string;
  createdAt: number;
  expiresAt: number;
}

export type WebRtcAutoSignalHandler = (message: WebRtcAutoSignalMessage) => void | Promise<void>;

export type WebRtcAutoSignalingState =
  'unavailable' | 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';

export interface WebRtcAutoSignalingStatus {
  name: 'websocket' | 'broadcast-channel' | 'supabase' | 'composite';
  available: boolean;
  state: WebRtcAutoSignalingState;
  url?: string;
  pendingMessages: number;
  reconnectAttempt: number;
  retryDelayMs?: number;
  lastConnectedAt?: number;
  lastDisconnectedAt?: number;
  lastError?: string;
  transports?: WebRtcAutoSignalingStatus[];
  privateNetwork?: SynpeerPrivateNetworkSnapshot | null;
}

export type SynpeerPrivateNetworkMemberStatus = 'pending' | 'approved' | 'blocked';

export interface SynpeerPrivateNetworkMember {
  peerId: PeerId;
  status: SynpeerPrivateNetworkMemberStatus;
  online: boolean;
  updatedAt: number;
}

export interface SynpeerPrivateNetworkSnapshot {
  networkId: string;
  name: string;
  ownerPeerId: PeerId;
  createdAt: number;
  members: SynpeerPrivateNetworkMember[];
}

export interface SynpeerPrivateNetworkInvite {
  version: 1;
  networkId: string;
  name: string;
  ownerPeerId: PeerId;
  createdAt: number;
  signalingUrl?: string;
}

export type SynpeerPrivateNetworkHandler = (
  snapshot: SynpeerPrivateNetworkSnapshot | null,
) => void | Promise<void>;

export interface WebRtcAutoSignalingTransport {
  isAvailable(): boolean;
  start(): void;
  stop(): void;
  subscribe(handler: WebRtcAutoSignalHandler): () => void;
  send(type: WebRtcAutoSignalType, toPeerId: PeerId, code: string): Promise<void>;
  getStatus(): WebRtcAutoSignalingStatus;
  createPrivateNetwork?(name: string): Promise<SynpeerPrivateNetworkInvite>;
  joinPrivateNetwork?(inviteCode: string): Promise<SynpeerPrivateNetworkSnapshot | null>;
  approvePrivateNetworkPeer?(peerId: PeerId): Promise<void>;
  setSignalingServerUrl?(url: string | null): void;
  getPrivateNetworkSnapshot?(): SynpeerPrivateNetworkSnapshot | null;
  subscribePrivateNetwork?(handler: SynpeerPrivateNetworkHandler): () => void;
}

type BroadcastChannelLike = {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
};

type BroadcastChannelConstructor = new (name: string) => BroadcastChannelLike;

type WebSocketLike = {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(message: string): void;
  close(): void;
};

type WebSocketConstructor = {
  readonly OPEN: number;
  new (url: string): WebSocketLike;
};

const CHANNEL_NAME = 'synpeer.webrtc.signaling.v1';
const SUPABASE_SIGNALING_CHANNEL = 'synpeer-signaling-v1';
const AUTO_SIGNAL_TTL_MS = 2 * 60 * 1000;
const DEFAULT_SIGNALING_PORT = '8787';
const PRIVATE_NETWORK_STORAGE_KEY = 'synpeer:privateNetwork:v1';
const LEGACY_PRIVATE_NETWORK_STORAGE_KEY = 'insta99:privateNetwork:v1';
const PRIVATE_NETWORK_APPROVAL_STORAGE_KEY = 'synpeer:privateNetworkApprovals:v1';
const LEGACY_PRIVATE_NETWORK_APPROVAL_STORAGE_KEY = 'insta99:privateNetworkApprovals:v1';
const SUPABASE_RECONNECT_BASE_DELAY_MS = 1000;
const SUPABASE_RECONNECT_MAX_DELAY_MS = 30000;
const SUPABASE_CLIENT_POOL_PROPERTY = '__synpeerSupabaseClientPool';
const LEGACY_SUPABASE_CLIENT_POOL_PROPERTY = '__insta99SupabaseClientPool';

type SupabaseClientPoolScope = typeof globalThis & {
  [SUPABASE_CLIENT_POOL_PROPERTY]?: Map<string, SupabaseClient>;
  [LEGACY_SUPABASE_CLIENT_POOL_PROPERTY]?: Map<string, SupabaseClient>;
};

function getSharedSupabaseClient(url: string, anonKey: string): SupabaseClient {
  const scope = globalThis as SupabaseClientPoolScope;
  const pool =
    scope[SUPABASE_CLIENT_POOL_PROPERTY] ??
    scope[LEGACY_SUPABASE_CLIENT_POOL_PROPERTY] ??
    new Map<string, SupabaseClient>();
  scope[SUPABASE_CLIENT_POOL_PROPERTY] = pool;
  const clientKey = sha256Hex(`${url}\u0000${anonKey}`);
  const existing = pool.get(clientKey);
  if (existing) {
    return existing;
  }

  const client = createClient(url, anonKey, {
    auth: {
      storageKey: `synpeer-signaling-${sha256Hex(url).slice(0, 16)}`,
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    realtime: {
      params: {
        eventsPerSecond: 20,
      },
    },
  });
  pool.set(clientKey, client);
  return client;
}

export function createWebRtcAutoSignalMessage(input: {
  type: WebRtcAutoSignalType;
  fromPeerId: PeerId;
  toPeerId: PeerId;
  code: string;
  createdAt?: number;
  expiresAt?: number;
}): WebRtcAutoSignalMessage {
  const createdAt = input.createdAt ?? Date.now();
  const unsigned = {
    version: 1,
    type: input.type,
    fromPeerId: input.fromPeerId,
    toPeerId: input.toPeerId,
    code: input.code,
    createdAt,
    expiresAt: input.expiresAt ?? createdAt + AUTO_SIGNAL_TTL_MS,
  } satisfies Omit<WebRtcAutoSignalMessage, 'id'>;

  return {
    ...unsigned,
    id: sha256Hex(JSON.stringify(unsigned)),
  };
}

export function validateWebRtcAutoSignalMessage(
  value: unknown,
  localPeerId: PeerId,
  now = Date.now(),
): WebRtcAutoSignalMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw createAutoSignalError('Auto signaling message must be an object', 'validate');
  }

  const message = value as Record<string, unknown>;
  if (
    message.version !== 1 ||
    (message.type !== 'offer' && message.type !== 'answer') ||
    typeof message.id !== 'string' ||
    typeof message.fromPeerId !== 'string' ||
    typeof message.toPeerId !== 'string' ||
    typeof message.code !== 'string' ||
    typeof message.createdAt !== 'number' ||
    typeof message.expiresAt !== 'number'
  ) {
    throw createAutoSignalError('Malformed auto signaling message', 'validate');
  }

  if (message.toPeerId !== localPeerId) {
    throw createAutoSignalError('Auto signaling message is addressed to another peer', 'route');
  }

  if (message.expiresAt < now) {
    throw createAutoSignalError('Auto signaling message expired', 'validate');
  }

  const unsigned = {
    version: 1,
    type: message.type,
    fromPeerId: message.fromPeerId,
    toPeerId: message.toPeerId,
    code: message.code,
    createdAt: message.createdAt,
    expiresAt: message.expiresAt,
  };
  if (sha256Hex(JSON.stringify(unsigned)) !== message.id) {
    throw createAutoSignalError('Auto signaling checksum mismatch', 'validate');
  }

  return {
    ...unsigned,
    id: message.id,
  } as WebRtcAutoSignalMessage;
}

export class CompositeWebRtcSignaling implements WebRtcAutoSignalingTransport {
  private readonly handlers = new Set<WebRtcAutoSignalHandler>();
  private readonly subscriptions: Array<() => void> = [];

  constructor(private readonly transports: WebRtcAutoSignalingTransport[]) {
    for (const transport of transports) {
      this.subscriptions.push(
        transport.subscribe((message) => {
          void this.emit(message);
        }),
      );
    }
  }

  isAvailable(): boolean {
    return this.transports.some((transport) => transport.isAvailable());
  }

  getStatus(): WebRtcAutoSignalingStatus {
    const transports = this.transports.map((transport) => transport.getStatus());
    return {
      name: 'composite',
      available: transports.some((transport) => transport.available),
      state: getCompositeState(transports),
      pendingMessages: transports.reduce(
        (total, transport) => total + transport.pendingMessages,
        0,
      ),
      reconnectAttempt: Math.max(0, ...transports.map((transport) => transport.reconnectAttempt)),
      transports,
      privateNetwork: this.getPrivateNetworkSnapshot(),
    };
  }

  start(): void {
    for (const transport of this.transports) {
      transport.start();
    }
  }

  stop(): void {
    for (const transport of this.transports) {
      transport.stop();
    }
  }

  subscribe(handler: WebRtcAutoSignalHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async send(type: WebRtcAutoSignalType, toPeerId: PeerId, code: string): Promise<void> {
    let sent = false;
    let lastError: unknown;
    for (const transport of this.transports) {
      if (!transport.isAvailable()) {
        continue;
      }
      try {
        await transport.send(type, toPeerId, code);
        sent = true;
      } catch (error) {
        lastError = error;
      }
    }

    if (!sent) {
      throw createAutoSignalError(
        lastError instanceof Error ? lastError.message : 'No auto signaling transport available',
        'send',
        lastError,
      );
    }
  }

  async createPrivateNetwork(name: string): Promise<SynpeerPrivateNetworkInvite> {
    return await this.getNetworkCapableTransport().createPrivateNetwork(name);
  }

  async joinPrivateNetwork(inviteCode: string): Promise<SynpeerPrivateNetworkSnapshot | null> {
    return await this.getNetworkCapableTransport().joinPrivateNetwork(inviteCode);
  }

  async approvePrivateNetworkPeer(peerId: PeerId): Promise<void> {
    await this.getNetworkCapableTransport().approvePrivateNetworkPeer(peerId);
  }

  setSignalingServerUrl(url: string | null): void {
    for (const transport of this.transports) {
      transport.setSignalingServerUrl?.(url);
    }
  }

  getPrivateNetworkSnapshot(): SynpeerPrivateNetworkSnapshot | null {
    return (
      this.transports
        .map((transport) => transport.getPrivateNetworkSnapshot?.() ?? null)
        .find((snapshot): snapshot is SynpeerPrivateNetworkSnapshot => snapshot !== null) ?? null
    );
  }

  subscribePrivateNetwork(handler: SynpeerPrivateNetworkHandler): () => void {
    const unsubscribes = this.transports
      .map((transport) => transport.subscribePrivateNetwork?.(handler))
      .filter((unsubscribe): unsubscribe is () => void => Boolean(unsubscribe));
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }

  private async emit(message: WebRtcAutoSignalMessage): Promise<void> {
    for (const handler of this.handlers) {
      await handler(message);
    }
  }

  private getNetworkCapableTransport(): Required<
    Pick<
      WebRtcAutoSignalingTransport,
      'createPrivateNetwork' | 'joinPrivateNetwork' | 'approvePrivateNetworkPeer'
    >
  > {
    const transport = this.transports.find(
      (
        item,
      ): item is WebRtcAutoSignalingTransport &
        Required<
          Pick<
            WebRtcAutoSignalingTransport,
            'createPrivateNetwork' | 'joinPrivateNetwork' | 'approvePrivateNetworkPeer'
          >
        > =>
        Boolean(
          item.createPrivateNetwork && item.joinPrivateNetwork && item.approvePrivateNetworkPeer,
        ),
    );
    if (!transport) {
      throw createAutoSignalError('Private network controller is not available', 'network');
    }
    return transport;
  }
}

export class BroadcastChannelWebRtcSignaling implements WebRtcAutoSignalingTransport {
  private readonly logger: Logger;
  private readonly handlers = new Set<WebRtcAutoSignalHandler>();
  private readonly seen = new Set<string>();
  private channel: BroadcastChannelLike | null = null;

  constructor(
    private readonly localPeerId: PeerId,
    logger: Logger = createLogger('webrtc.auto.signaling'),
  ) {
    this.logger = logger;
  }

  isAvailable(): boolean {
    return Boolean(getBroadcastChannelConstructor());
  }

  getStatus(): WebRtcAutoSignalingStatus {
    const available = this.isAvailable();
    return {
      name: 'broadcast-channel',
      available,
      state: available ? (this.channel ? 'connected' : 'idle') : 'unavailable',
      pendingMessages: 0,
      reconnectAttempt: 0,
    };
  }

  start(): void {
    if (this.channel || !this.isAvailable()) {
      return;
    }

    const Channel = getBroadcastChannelConstructor();
    if (!Channel) {
      return;
    }

    this.channel = new Channel(CHANNEL_NAME);
    this.channel.onmessage = (event) => {
      void this.handleRawMessage(event.data);
    };
    this.logger.info('auto_signaling_started', { peerId: this.localPeerId });
  }

  stop(): void {
    this.channel?.close();
    this.channel = null;
    this.seen.clear();
  }

  subscribe(handler: WebRtcAutoSignalHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async send(type: WebRtcAutoSignalType, toPeerId: PeerId, code: string): Promise<void> {
    if (!this.channel) {
      this.start();
    }
    if (!this.channel) {
      throw createAutoSignalError('BroadcastChannel signaling is not available', 'send');
    }

    const message = createWebRtcAutoSignalMessage({
      type,
      fromPeerId: this.localPeerId,
      toPeerId,
      code,
    });
    this.seen.add(message.id);
    this.channel.postMessage(message);
    this.logger.info('auto_signal_sent', {
      peerId: toPeerId,
      signalType: type,
    });
  }

  private async handleRawMessage(value: unknown): Promise<void> {
    let message: WebRtcAutoSignalMessage;
    try {
      message = validateWebRtcAutoSignalMessage(value, this.localPeerId);
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      if (appError?.context.operation === 'route') {
        return;
      }
      this.logger.warn('auto_signal_rejected', {
        message: error instanceof Error ? error.message : 'Invalid auto signaling message',
      });
      return;
    }

    if (message.fromPeerId === this.localPeerId || this.seen.has(message.id)) {
      return;
    }

    this.seen.add(message.id);
    for (const handler of this.handlers) {
      try {
        await handler(message);
      } catch (error) {
        this.logger.error('auto_signal_handler_failed', error, {
          peerId: message.fromPeerId,
          signalType: message.type,
        });
      }
    }
  }
}

type SupabasePresencePayload = {
  peerId: PeerId;
  networkId: string;
  status: SynpeerPrivateNetworkMemberStatus;
  joinedAt: number;
};

type SupabaseNetworkEventPayload =
  | {
      type: 'network-join';
      network: SynpeerPrivateNetworkInvite;
      peerId: PeerId;
      createdAt: number;
    }
  | {
      type: 'network-approve';
      networkId: string;
      peerId: PeerId;
      approvedByPeerId: PeerId;
      createdAt: number;
    };

export class SupabaseRealtimeWebRtcSignaling implements WebRtcAutoSignalingTransport {
  private readonly logger: Logger;
  private readonly handlers = new Set<WebRtcAutoSignalHandler>();
  private readonly networkHandlers = new Set<SynpeerPrivateNetworkHandler>();
  private readonly pendingSignals: Array<{
    type: WebRtcAutoSignalType;
    toPeerId: PeerId;
    code: string;
  }> = [];
  private readonly seen = new Set<string>();
  private readonly approvedPeers = readPrivateNetworkApprovals();
  private client: SupabaseClient | null = null;
  private signalingChannel: RealtimeChannel | null = null;
  private networkChannel: RealtimeChannel | null = null;
  private state: WebRtcAutoSignalingState = 'idle';
  private stopped = false;
  private reconnectAttempt = 0;
  private retryDelayMs: number | undefined;
  private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private lastConnectedAt: number | undefined;
  private lastDisconnectedAt: number | undefined;
  private lastError: string | undefined;
  private privateNetwork: SynpeerPrivateNetworkSnapshot | null = null;
  private storedNetwork: SynpeerPrivateNetworkInvite | null = readStoredPrivateNetworkInvite();

  constructor(
    private readonly localPeerId: PeerId,
    private readonly url: string | null = getSupabaseUrl(),
    private readonly anonKey: string | null = getSupabaseAnonKey(),
    logger: Logger = createLogger('webrtc.supabase.signaling'),
  ) {
    this.logger = logger;
  }

  isAvailable(): boolean {
    return Boolean(this.url && this.anonKey);
  }

  getStatus(): WebRtcAutoSignalingStatus {
    const available = this.isAvailable();
    return {
      name: 'supabase',
      available,
      state: available ? this.state : 'unavailable',
      url: this.url ?? undefined,
      pendingMessages: this.pendingSignals.length,
      reconnectAttempt: this.reconnectAttempt,
      retryDelayMs: this.retryDelayMs,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastError: this.lastError,
      privateNetwork: this.privateNetwork,
    };
  }

  start(): void {
    if (!this.isAvailable() || this.client || !this.url || !this.anonKey) {
      return;
    }
    this.stopped = false;
    this.clearReconnectTimer();
    this.state = 'connecting';
    this.client = getSharedSupabaseClient(this.url, this.anonKey);
    this.signalingChannel = this.client.channel(SUPABASE_SIGNALING_CHANNEL, {
      config: {
        broadcast: { self: false, ack: false },
        presence: { key: this.localPeerId },
      },
    });
    this.signalingChannel
      .on('broadcast', { event: 'signal' }, ({ payload }: { payload: unknown }) => {
        void this.handleSignalPayload(payload);
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          this.state = 'connected';
          this.reconnectAttempt = 0;
          this.retryDelayMs = undefined;
          this.lastConnectedAt = Date.now();
          this.lastError = undefined;
          void this.flushPendingSignals();
          this.registerStoredNetwork();
          this.logger.info('supabase_signaling_connected', { peerId: this.localPeerId });
          return;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.handleSignalingUnavailable(status);
        }
      });
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.state = 'stopped';
    this.lastDisconnectedAt = Date.now();
    this.teardownChannels();
    this.pendingSignals.length = 0;
    this.seen.clear();
  }

  subscribe(handler: WebRtcAutoSignalHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async send(type: WebRtcAutoSignalType, toPeerId: PeerId, code: string): Promise<void> {
    if (!this.signalingChannel) {
      this.start();
    }
    if (!this.signalingChannel || this.state !== 'connected') {
      this.pendingSignals.push({ type, toPeerId, code });
      return;
    }
    await this.sendSignalNow(type, toPeerId, code);
  }

  async createPrivateNetwork(name: string): Promise<SynpeerPrivateNetworkInvite> {
    const createdAt = Date.now();
    const invite: SynpeerPrivateNetworkInvite = {
      version: 1,
      networkId: sha256Hex(
        JSON.stringify({
          name,
          ownerPeerId: this.localPeerId,
          createdAt,
          signaling: 'supabase',
        }),
      ).slice(0, 24),
      name: name.trim() || 'Synpeer Network',
      ownerPeerId: this.localPeerId,
      createdAt,
    };
    this.storedNetwork = invite;
    this.approvedPeers.add(this.localPeerId);
    persistPrivateNetworkInvite(invite);
    persistPrivateNetworkApprovals(this.approvedPeers);
    this.joinNetworkChannel(invite);
    return invite;
  }

  async joinPrivateNetwork(inviteCode: string): Promise<SynpeerPrivateNetworkSnapshot | null> {
    const invite = decodePrivateNetworkInvite(inviteCode);
    this.storedNetwork = invite;
    persistPrivateNetworkInvite(invite);
    this.joinNetworkChannel(invite);
    await this.sendNetworkEvent({
      type: 'network-join',
      network: invite,
      peerId: this.localPeerId,
      createdAt: Date.now(),
    });
    return this.privateNetwork;
  }

  async approvePrivateNetworkPeer(peerId: PeerId): Promise<void> {
    if (!this.storedNetwork) {
      throw createAutoSignalError('No private network configured', 'network');
    }
    this.approvedPeers.add(peerId);
    persistPrivateNetworkApprovals(this.approvedPeers);
    await this.sendNetworkEvent({
      type: 'network-approve',
      networkId: this.storedNetwork.networkId,
      peerId,
      approvedByPeerId: this.localPeerId,
      createdAt: Date.now(),
    });
    void this.trackPresence();
    this.updatePrivateNetworkFromPresence();
  }

  getPrivateNetworkSnapshot(): SynpeerPrivateNetworkSnapshot | null {
    return this.privateNetwork;
  }

  subscribePrivateNetwork(handler: SynpeerPrivateNetworkHandler): () => void {
    this.networkHandlers.add(handler);
    return () => {
      this.networkHandlers.delete(handler);
    };
  }

  private async sendSignalNow(
    type: WebRtcAutoSignalType,
    toPeerId: PeerId,
    code: string,
  ): Promise<void> {
    if (!this.signalingChannel) {
      throw createAutoSignalError('Supabase signaling is not connected', 'send');
    }
    const message = createWebRtcAutoSignalMessage({
      type,
      fromPeerId: this.localPeerId,
      toPeerId,
      code,
    });
    this.seen.add(message.id);
    await this.signalingChannel.send({
      type: 'broadcast',
      event: 'signal',
      payload: message,
    });
    this.logger.info('supabase_signal_sent', { peerId: toPeerId, signalType: type });
  }

  private async flushPendingSignals(): Promise<void> {
    while (this.pendingSignals.length > 0) {
      const signal = this.pendingSignals.shift();
      if (signal) {
        await this.sendSignalNow(signal.type, signal.toPeerId, signal.code);
      }
    }
  }

  private async handleSignalPayload(payload: unknown): Promise<void> {
    let message: WebRtcAutoSignalMessage;
    try {
      message = validateWebRtcAutoSignalMessage(payload, this.localPeerId);
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      if (appError?.context.operation === 'route') {
        return;
      }
      this.logger.warn('supabase_signal_rejected', {
        message: error instanceof Error ? error.message : 'Invalid Supabase signal',
      });
      return;
    }
    if (message.fromPeerId === this.localPeerId || this.seen.has(message.id)) {
      return;
    }
    this.seen.add(message.id);
    for (const handler of this.handlers) {
      await handler(message);
    }
  }

  private registerStoredNetwork(): void {
    if (this.storedNetwork) {
      this.joinNetworkChannel(this.storedNetwork);
    }
  }

  private joinNetworkChannel(invite: SynpeerPrivateNetworkInvite): void {
    if (!this.client) {
      this.start();
    }
    if (!this.client) {
      return;
    }
    const channelName = `synpeer-network-${invite.networkId}`;
    if (this.networkChannel?.topic === `realtime:${channelName}`) {
      void this.trackPresence();
      return;
    }
    if (this.networkChannel) {
      void this.client.removeChannel(this.networkChannel);
    }
    this.networkChannel = this.client.channel(channelName, {
      config: {
        broadcast: { self: false, ack: false },
        presence: { key: this.localPeerId },
      },
    });
    this.networkChannel
      .on('broadcast', { event: 'network' }, ({ payload }: { payload: unknown }) => {
        void this.handleNetworkEvent(payload);
      })
      .on('presence', { event: 'sync' }, () => {
        this.updatePrivateNetworkFromPresence();
      })
      .on('presence', { event: 'join' }, () => {
        this.updatePrivateNetworkFromPresence();
      })
      .on('presence', { event: 'leave' }, () => {
        this.updatePrivateNetworkFromPresence();
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          void this.trackPresence();
          this.updatePrivateNetworkFromPresence();
          return;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.handleNetworkUnavailable(status);
        }
      });
  }

  private async trackPresence(): Promise<void> {
    if (!this.networkChannel || !this.storedNetwork) {
      return;
    }
    const isOwner = this.storedNetwork.ownerPeerId === this.localPeerId;
    const status: SynpeerPrivateNetworkMemberStatus =
      isOwner || this.approvedPeers.has(this.localPeerId) ? 'approved' : 'pending';
    await this.networkChannel.track({
      peerId: this.localPeerId,
      networkId: this.storedNetwork.networkId,
      status,
      joinedAt: Date.now(),
    } satisfies SupabasePresencePayload);
  }

  private async sendNetworkEvent(payload: SupabaseNetworkEventPayload): Promise<void> {
    if (!this.networkChannel) {
      const network = payload.type === 'network-join' ? payload.network : this.storedNetwork;
      if (!network) {
        throw createAutoSignalError('No private network configured', 'network');
      }
      this.joinNetworkChannel(network);
    }
    await this.networkChannel?.send({
      type: 'broadcast',
      event: 'network',
      payload,
    });
  }

  private async handleNetworkEvent(payload: unknown): Promise<void> {
    const event = parseSupabaseNetworkEvent(payload);
    if (!event || !this.storedNetwork || event.networkId !== this.storedNetwork.networkId) {
      return;
    }
    if (event.type === 'network-approve' && event.peerId === this.localPeerId) {
      this.approvedPeers.add(this.localPeerId);
      persistPrivateNetworkApprovals(this.approvedPeers);
      await this.trackPresence();
    }
    this.updatePrivateNetworkFromPresence();
  }

  private updatePrivateNetworkFromPresence(): void {
    if (!this.networkChannel || !this.storedNetwork) {
      return;
    }
    const state = this.networkChannel.presenceState<SupabasePresencePayload>();
    const members = Object.values(state)
      .flat()
      .filter((presence) => presence.networkId === this.storedNetwork?.networkId)
      .reduce<Map<PeerId, SynpeerPrivateNetworkMember>>((items, presence) => {
        const previous = items.get(presence.peerId);
        const isOwner = presence.peerId === this.storedNetwork?.ownerPeerId;
        const status: SynpeerPrivateNetworkMemberStatus =
          isOwner || this.approvedPeers.has(presence.peerId) ? 'approved' : presence.status;
        if (!previous || previous.updatedAt < presence.joinedAt) {
          items.set(presence.peerId, {
            peerId: presence.peerId,
            status,
            online: true,
            updatedAt: presence.joinedAt,
          });
        }
        return items;
      }, new Map());

    if (!members.has(this.localPeerId)) {
      const isOwner = this.storedNetwork.ownerPeerId === this.localPeerId;
      members.set(this.localPeerId, {
        peerId: this.localPeerId,
        status: isOwner || this.approvedPeers.has(this.localPeerId) ? 'approved' : 'pending',
        online: true,
        updatedAt: Date.now(),
      });
    }

    this.privateNetwork = {
      networkId: this.storedNetwork.networkId,
      name: this.storedNetwork.name,
      ownerPeerId: this.storedNetwork.ownerPeerId,
      createdAt: this.storedNetwork.createdAt,
      members: Array.from(members.values()).sort((left, right) =>
        left.peerId.localeCompare(right.peerId),
      ),
    };
    for (const handler of this.networkHandlers) {
      void handler(this.privateNetwork);
    }
  }

  private handleSignalingUnavailable(status: 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED'): void {
    if (this.stopped) {
      this.state = 'stopped';
      return;
    }
    this.state = 'reconnecting';
    this.lastDisconnectedAt = Date.now();
    this.lastError = status;
    this.logger.warn('supabase_signaling_unavailable', {
      status,
      reconnectAttempt: this.reconnectAttempt,
    });
    this.scheduleReconnect();
  }

  private handleNetworkUnavailable(status: 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED'): void {
    if (this.stopped) {
      return;
    }
    this.lastError = status;
    this.logger.warn('supabase_network_channel_unavailable', {
      status,
      networkId: this.storedNetwork?.networkId,
    });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) {
      return;
    }
    this.reconnectAttempt += 1;
    const delayMs = Math.min(
      SUPABASE_RECONNECT_MAX_DELAY_MS,
      SUPABASE_RECONNECT_BASE_DELAY_MS * 2 ** Math.min(5, this.reconnectAttempt - 1),
    );
    this.retryDelayMs = delayMs;
    this.state = 'reconnecting';
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) {
        return;
      }
      this.teardownChannels();
      this.state = 'idle';
      this.start();
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    globalThis.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.retryDelayMs = undefined;
  }

  private teardownChannels(): void {
    const client = this.client;
    const signalingChannel = this.signalingChannel;
    const networkChannel = this.networkChannel;
    this.client = null;
    this.signalingChannel = null;
    this.networkChannel = null;
    if (signalingChannel) {
      void client?.removeChannel(signalingChannel);
    }
    if (networkChannel) {
      void client?.removeChannel(networkChannel);
    }
  }
}

export class WebSocketWebRtcSignaling implements WebRtcAutoSignalingTransport {
  private readonly logger: Logger;
  private readonly handlers = new Set<WebRtcAutoSignalHandler>();
  private readonly networkHandlers = new Set<SynpeerPrivateNetworkHandler>();
  private readonly pending: string[] = [];
  private readonly seen = new Set<string>();
  private socket: WebSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private reconnectAttempt = 0;
  private retryDelayMs: number | undefined;
  private lastConnectedAt: number | undefined;
  private lastDisconnectedAt: number | undefined;
  private lastError: string | undefined;
  private state: WebRtcAutoSignalingState = 'idle';
  private stopped = false;
  private privateNetwork: SynpeerPrivateNetworkSnapshot | null = null;
  private storedNetwork: SynpeerPrivateNetworkInvite | null;
  private url: string | null;

  constructor(
    private readonly localPeerId: PeerId,
    url?: string | null,
    logger: Logger = createLogger('webrtc.websocket.signaling'),
  ) {
    this.logger = logger;
    this.storedNetwork = readStoredPrivateNetworkInvite();
    this.url = url ?? this.storedNetwork?.signalingUrl ?? getDefaultWebRtcSignalingServerUrl();
  }

  isAvailable(): boolean {
    return Boolean(this.url && getWebSocketConstructor());
  }

  getStatus(): WebRtcAutoSignalingStatus {
    const available = this.isAvailable();
    return {
      name: 'websocket',
      available,
      state: available ? this.state : 'unavailable',
      url: this.url ?? undefined,
      pendingMessages: this.pending.length,
      reconnectAttempt: this.reconnectAttempt,
      retryDelayMs: this.retryDelayMs,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastError: this.lastError,
      privateNetwork: this.privateNetwork,
    };
  }

  start(): void {
    if (this.socket || !this.isAvailable() || !this.url) {
      return;
    }
    this.stopped = false;
    this.clearReconnectTimer();
    this.state = 'connecting';

    const Socket = getWebSocketConstructor();
    if (!Socket) {
      return;
    }

    this.socket = new Socket(this.url);
    this.socket.onopen = () => {
      this.sendRaw({
        kind: 'hello',
        version: 1,
        peerId: this.localPeerId,
      });
      this.registerStoredNetwork();
      this.flushPending();
      this.reconnectAttempt = 0;
      this.retryDelayMs = undefined;
      this.lastConnectedAt = Date.now();
      this.lastError = undefined;
      this.state = 'connected';
      this.logger.info('websocket_signaling_connected', { peerId: this.localPeerId });
    };
    this.socket.onmessage = (event) => {
      void this.handleRawMessage(event.data);
    };
    this.socket.onclose = () => {
      this.socket = null;
      this.lastDisconnectedAt = Date.now();
      if (this.stopped) {
        this.state = 'stopped';
        this.logger.debug('websocket_signaling_stopped', { peerId: this.localPeerId });
        return;
      }
      this.scheduleReconnect();
    };
    this.socket.onerror = () => {
      this.lastError = 'WebSocket signaling error';
      this.logger.warn('websocket_signaling_error', {
        peerId: this.localPeerId,
        reconnectAttempt: this.reconnectAttempt,
      });
    };
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.socket?.close();
    this.socket = null;
    this.state = 'stopped';
    this.pending.length = 0;
    this.seen.clear();
  }

  subscribe(handler: WebRtcAutoSignalHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async send(type: WebRtcAutoSignalType, toPeerId: PeerId, code: string): Promise<void> {
    if (!this.socket) {
      this.start();
    }
    if (!this.socket) {
      throw createAutoSignalError('WebSocket signaling is not available', 'send');
    }

    const message = createWebRtcAutoSignalMessage({
      type,
      fromPeerId: this.localPeerId,
      toPeerId,
      code,
    });
    this.seen.add(message.id);
    const serialized = JSON.stringify({ kind: 'signal', message });
    if (this.isOpen()) {
      this.socket.send(serialized);
    } else {
      this.pending.push(serialized);
    }
    this.logger.info('websocket_signal_queued', { peerId: toPeerId, signalType: type });
  }

  async createPrivateNetwork(name: string): Promise<SynpeerPrivateNetworkInvite> {
    const createdAt = Date.now();
    const invite: SynpeerPrivateNetworkInvite = {
      version: 1,
      networkId: sha256Hex(
        JSON.stringify({
          name,
          ownerPeerId: this.localPeerId,
          createdAt,
        }),
      ).slice(0, 24),
      name: name.trim() || 'Synpeer Network',
      ownerPeerId: this.localPeerId,
      createdAt,
      signalingUrl: this.url ?? undefined,
    };
    this.storedNetwork = invite;
    persistPrivateNetworkInvite(invite);
    this.sendNetworkCreate(invite);
    return invite;
  }

  async joinPrivateNetwork(inviteCode: string): Promise<SynpeerPrivateNetworkSnapshot | null> {
    const invite = decodePrivateNetworkInvite(inviteCode);
    if (invite.signalingUrl && invite.signalingUrl !== this.url) {
      this.setSignalingServerUrl(invite.signalingUrl);
    }
    this.storedNetwork = invite;
    persistPrivateNetworkInvite(invite);
    this.sendNetworkJoin(invite);
    return this.privateNetwork;
  }

  async approvePrivateNetworkPeer(peerId: PeerId): Promise<void> {
    if (!this.storedNetwork) {
      throw createAutoSignalError('No private network configured', 'network');
    }
    this.sendRaw({
      kind: 'network-approve',
      version: 1,
      networkId: this.storedNetwork.networkId,
      peerId,
    });
  }

  setSignalingServerUrl(url: string | null): void {
    const nextUrl = normalizeSignalingServerUrl(url);
    if (nextUrl === this.url) {
      return;
    }
    this.url = nextUrl;
    if (this.storedNetwork) {
      this.storedNetwork = {
        ...this.storedNetwork,
        signalingUrl: nextUrl ?? undefined,
      };
      persistPrivateNetworkInvite(this.storedNetwork);
    }
    const shouldRestart =
      this.state === 'connected' || this.state === 'connecting' || this.state === 'reconnecting';
    this.clearReconnectTimer();
    this.socket?.close();
    this.socket = null;
    this.state = nextUrl ? 'idle' : 'unavailable';
    if (shouldRestart && nextUrl) {
      this.start();
    }
  }

  getPrivateNetworkSnapshot(): SynpeerPrivateNetworkSnapshot | null {
    return this.privateNetwork;
  }

  subscribePrivateNetwork(handler: SynpeerPrivateNetworkHandler): () => void {
    this.networkHandlers.add(handler);
    return () => {
      this.networkHandlers.delete(handler);
    };
  }

  private async handleRawMessage(value: unknown): Promise<void> {
    const parsed = parseJsonObject(value);
    if (!parsed) {
      return;
    }

    if (parsed.kind === 'network-update') {
      await this.handleNetworkUpdate(parsed.network);
      return;
    }

    if (parsed.kind !== 'signal') {
      return;
    }

    let message: WebRtcAutoSignalMessage;
    try {
      message = validateWebRtcAutoSignalMessage(parsed.message, this.localPeerId);
    } catch (error) {
      this.logger.warn('websocket_signal_rejected', {
        message: error instanceof Error ? error.message : 'Invalid WebSocket signal',
      });
      return;
    }

    if (message.fromPeerId === this.localPeerId || this.seen.has(message.id)) {
      return;
    }

    this.seen.add(message.id);
    for (const handler of this.handlers) {
      try {
        await handler(message);
      } catch (error) {
        this.logger.error('websocket_signal_handler_failed', error, {
          peerId: message.fromPeerId,
          signalType: message.type,
        });
      }
    }
  }

  private flushPending(): void {
    while (this.pending.length > 0 && this.isOpen()) {
      const message = this.pending.shift();
      if (message) {
        this.socket?.send(message);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) {
      return;
    }

    this.reconnectAttempt += 1;
    const delayMs = Math.min(30000, 1000 * 2 ** Math.min(5, this.reconnectAttempt - 1));
    this.retryDelayMs = delayMs;
    this.state = 'reconnecting';
    this.logger.warn('websocket_signaling_disconnected', {
      peerId: this.localPeerId,
      reconnectAttempt: this.reconnectAttempt,
      retryDelayMs: delayMs,
    });
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    globalThis.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.retryDelayMs = undefined;
  }

  private sendRaw(value: unknown): void {
    const serialized = JSON.stringify(value);
    if (this.isOpen()) {
      this.socket?.send(serialized);
    } else {
      this.pending.push(serialized);
    }
  }

  private isOpen(): boolean {
    const Socket = getWebSocketConstructor();
    return Boolean(this.socket && Socket && this.socket.readyState === Socket.OPEN);
  }

  private registerStoredNetwork(): void {
    if (!this.storedNetwork) {
      return;
    }
    if (this.storedNetwork.ownerPeerId === this.localPeerId) {
      this.sendNetworkCreate(this.storedNetwork);
    } else {
      this.sendNetworkJoin(this.storedNetwork);
    }
  }

  private sendNetworkCreate(invite: SynpeerPrivateNetworkInvite): void {
    this.sendRaw({
      kind: 'network-create',
      version: 1,
      networkId: invite.networkId,
      name: invite.name,
    });
  }

  private sendNetworkJoin(invite: SynpeerPrivateNetworkInvite): void {
    this.sendRaw({
      kind: 'network-join',
      version: 1,
      networkId: invite.networkId,
      name: invite.name,
      ownerPeerId: invite.ownerPeerId,
    });
  }

  private async handleNetworkUpdate(value: unknown): Promise<void> {
    if (!isPrivateNetworkSnapshot(value)) {
      this.logger.warn('private_network_update_rejected');
      return;
    }
    this.privateNetwork = value;
    for (const handler of this.networkHandlers) {
      await handler(value);
    }
  }
}

export function createDefaultWebRtcAutoSignaling(
  localPeerId: PeerId,
): WebRtcAutoSignalingTransport {
  const transports: WebRtcAutoSignalingTransport[] = [];
  if (getSupabaseUrl() && getSupabaseAnonKey()) {
    transports.push(new SupabaseRealtimeWebRtcSignaling(localPeerId));
  }
  transports.push(new WebSocketWebRtcSignaling(localPeerId));
  transports.push(new BroadcastChannelWebRtcSignaling(localPeerId));
  return new CompositeWebRtcSignaling(transports);
}

function getBroadcastChannelConstructor(): BroadcastChannelConstructor | null {
  const scope = globalThis as { BroadcastChannel?: BroadcastChannelConstructor };
  return scope.BroadcastChannel ?? null;
}

function getCompositeState(
  transports: readonly WebRtcAutoSignalingStatus[],
): WebRtcAutoSignalingState {
  if (transports.some((transport) => transport.state === 'connected')) {
    return 'connected';
  }
  if (transports.some((transport) => transport.state === 'connecting')) {
    return 'connecting';
  }
  if (transports.some((transport) => transport.state === 'reconnecting')) {
    return 'reconnecting';
  }
  if (transports.some((transport) => transport.state === 'idle')) {
    return 'idle';
  }
  if (transports.every((transport) => transport.state === 'stopped')) {
    return 'stopped';
  }
  return 'unavailable';
}

function getWebSocketConstructor(): WebSocketConstructor | null {
  const scope = globalThis as { WebSocket?: WebSocketConstructor };
  return scope.WebSocket ?? null;
}

function getDefaultWebRtcSignalingServerUrl(): string | null {
  const scope = globalThis as {
    __SYNPEER_SIGNALING_URL__?: unknown;
    __INSTA99_SIGNALING_URL__?: unknown;
    location?: { protocol?: string; hostname?: string };
    process?: { env?: Record<string, string | undefined> };
  };
  if (typeof scope.__SYNPEER_SIGNALING_URL__ === 'string') {
    return scope.__SYNPEER_SIGNALING_URL__;
  }
  if (typeof scope.__INSTA99_SIGNALING_URL__ === 'string') {
    return scope.__INSTA99_SIGNALING_URL__;
  }
  const configured =
    scope.process?.env?.EXPO_PUBLIC_SYNPEER_SIGNALING_URL ??
    scope.process?.env?.EXPO_PUBLIC_INSTA99_SIGNALING_URL;
  if (configured) {
    return configured;
  }
  const hostname = scope.location?.hostname;
  if (!hostname) {
    return null;
  }
  const protocol = scope.location?.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${hostname}:${DEFAULT_SIGNALING_PORT}`;
}

function getSupabaseUrl(): string | null {
  const scope = globalThis as {
    __SYNPEER_SUPABASE_URL__?: unknown;
    __INSTA99_SUPABASE_URL__?: unknown;
  };
  const configured =
    typeof scope.__SYNPEER_SUPABASE_URL__ === 'string'
      ? scope.__SYNPEER_SUPABASE_URL__
      : typeof scope.__INSTA99_SUPABASE_URL__ === 'string'
        ? scope.__INSTA99_SUPABASE_URL__
        : BUNDLED_SUPABASE_URL;
  return normalizeHttpUrl(configured);
}

function getSupabaseAnonKey(): string | null {
  const scope = globalThis as {
    __SYNPEER_SUPABASE_ANON_KEY__?: unknown;
    __INSTA99_SUPABASE_ANON_KEY__?: unknown;
  };
  const configured =
    typeof scope.__SYNPEER_SUPABASE_ANON_KEY__ === 'string'
      ? scope.__SYNPEER_SUPABASE_ANON_KEY__
      : typeof scope.__INSTA99_SUPABASE_ANON_KEY__ === 'string'
        ? scope.__INSTA99_SUPABASE_ANON_KEY__
        : BUNDLED_SUPABASE_ANON_KEY;
  return configured?.trim() || null;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function encodePrivateNetworkInvite(invite: SynpeerPrivateNetworkInvite): string {
  const UrlSearchParams = globalThis.URLSearchParams;
  const params = new UrlSearchParams();
  params.set('v', String(invite.version));
  params.set('networkId', invite.networkId);
  params.set('name', invite.name);
  params.set('ownerPeerId', invite.ownerPeerId);
  params.set('createdAt', String(invite.createdAt));
  if (invite.signalingUrl) {
    params.set('signalingUrl', invite.signalingUrl);
  }
  return `${URI_SCHEME}:network?${params.toString()}`;
}

export function decodePrivateNetworkInvite(value: string): SynpeerPrivateNetworkInvite {
  let url: InstanceType<typeof globalThis.URL>;
  try {
    const UrlConstructor = globalThis.URL;
    url = new UrlConstructor(value);
  } catch (error) {
    throw createAutoSignalError('Invalid Synpeer network invite', 'network', error);
  }
  const supportedProtocols = [`${URI_SCHEME}:`, `${LEGACY_URI_SCHEME}:`];
  if (!supportedProtocols.includes(url.protocol) || url.pathname !== 'network') {
    throw createAutoSignalError('Unsupported Synpeer network invite', 'network');
  }

  const version = Number(url.searchParams.get('v'));
  const networkId = url.searchParams.get('networkId');
  const name = url.searchParams.get('name');
  const ownerPeerId = url.searchParams.get('ownerPeerId');
  const createdAt = Number(url.searchParams.get('createdAt'));
  const signalingUrl = url.searchParams.get('signalingUrl') ?? undefined;
  if (version !== 1 || !networkId || !name || !ownerPeerId || !Number.isFinite(createdAt)) {
    throw createAutoSignalError('Malformed Synpeer network invite', 'network');
  }

  return {
    version: 1,
    networkId,
    name,
    ownerPeerId: ownerPeerId as PeerId,
    createdAt,
    signalingUrl: normalizeSignalingServerUrl(signalingUrl) ?? undefined,
  };
}

function readStoredPrivateNetworkInvite(): SynpeerPrivateNetworkInvite | null {
  const storage = getBrowserStorage();
  const current = storage?.getItem(PRIVATE_NETWORK_STORAGE_KEY);
  const stored = current ?? storage?.getItem(LEGACY_PRIVATE_NETWORK_STORAGE_KEY);
  if (!stored) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!isPrivateNetworkInvite(parsed)) {
      return null;
    }
    if (!current) {
      persistPrivateNetworkInvite(parsed);
    }
    return parsed;
  } catch {
    return null;
  }
}

function persistPrivateNetworkInvite(invite: SynpeerPrivateNetworkInvite): void {
  getBrowserStorage()?.setItem(PRIVATE_NETWORK_STORAGE_KEY, JSON.stringify(invite));
}

function readPrivateNetworkApprovals(): Set<PeerId> {
  const storage = getBrowserStorage();
  const current = storage?.getItem(PRIVATE_NETWORK_APPROVAL_STORAGE_KEY);
  const stored = current ?? storage?.getItem(LEGACY_PRIVATE_NETWORK_APPROVAL_STORAGE_KEY);
  if (!stored) {
    return new Set();
  }
  try {
    const parsed: unknown = JSON.parse(stored);
    const approvals: Set<PeerId> = Array.isArray(parsed)
      ? new Set(parsed.filter((item): item is PeerId => typeof item === 'string'))
      : new Set<PeerId>();
    if (!current) {
      persistPrivateNetworkApprovals(approvals);
    }
    return approvals;
  } catch {
    return new Set();
  }
}

function persistPrivateNetworkApprovals(peers: ReadonlySet<PeerId>): void {
  getBrowserStorage()?.setItem(
    PRIVATE_NETWORK_APPROVAL_STORAGE_KEY,
    JSON.stringify(Array.from(peers.values()).sort()),
  );
}

function isPrivateNetworkInvite(value: unknown): value is SynpeerPrivateNetworkInvite {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).version === 1 &&
    typeof (value as Record<string, unknown>).networkId === 'string' &&
    typeof (value as Record<string, unknown>).name === 'string' &&
    typeof (value as Record<string, unknown>).ownerPeerId === 'string' &&
    typeof (value as Record<string, unknown>).createdAt === 'number' &&
    (typeof (value as Record<string, unknown>).signalingUrl === 'undefined' ||
      typeof (value as Record<string, unknown>).signalingUrl === 'string')
  );
}

function normalizeSignalingServerUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const UrlConstructor = globalThis.URL;
    const parsed = new UrlConstructor(trimmed);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeHttpUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const UrlConstructor = globalThis.URL;
    const parsed = new UrlConstructor(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseSupabaseNetworkEvent(
  value: unknown,
): ({ networkId: string } & SupabaseNetworkEventPayload) | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const event = value as Record<string, unknown>;
  if (
    event.type === 'network-join' &&
    isPrivateNetworkInvite(event.network) &&
    typeof event.peerId === 'string' &&
    typeof event.createdAt === 'number'
  ) {
    return {
      type: 'network-join',
      network: event.network,
      networkId: event.network.networkId,
      peerId: event.peerId as PeerId,
      createdAt: event.createdAt,
    };
  }
  if (
    event.type === 'network-approve' &&
    typeof event.networkId === 'string' &&
    typeof event.peerId === 'string' &&
    typeof event.approvedByPeerId === 'string' &&
    typeof event.createdAt === 'number'
  ) {
    return {
      type: 'network-approve',
      networkId: event.networkId,
      peerId: event.peerId as PeerId,
      approvedByPeerId: event.approvedByPeerId as PeerId,
      createdAt: event.createdAt,
    };
  }
  return null;
}

function isPrivateNetworkSnapshot(value: unknown): value is SynpeerPrivateNetworkSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.networkId === 'string' &&
    typeof snapshot.name === 'string' &&
    typeof snapshot.ownerPeerId === 'string' &&
    typeof snapshot.createdAt === 'number' &&
    Array.isArray(snapshot.members) &&
    snapshot.members.every(isPrivateNetworkMember)
  );
}

function isPrivateNetworkMember(value: unknown): value is SynpeerPrivateNetworkMember {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const member = value as Record<string, unknown>;
  return (
    typeof member.peerId === 'string' &&
    (member.status === 'pending' || member.status === 'approved' || member.status === 'blocked') &&
    typeof member.online === 'boolean' &&
    typeof member.updatedAt === 'number'
  );
}

type BrowserStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function getBrowserStorage(): BrowserStorage | null {
  const scope = globalThis as { localStorage?: BrowserStorage };
  return scope.localStorage ?? null;
}

function createAutoSignalError(message: string, operation: string, cause?: unknown): AppError {
  return new AppError({
    code: 'NETWORK_ERROR',
    message,
    safeMessage: 'A conexao automatica entre peers nao esta disponivel neste ambiente.',
    severity: 'warning',
    retryable: operation !== 'validate',
    cause,
    context: {
      scope: 'webrtc.auto.signaling',
      operation,
    },
  });
}
