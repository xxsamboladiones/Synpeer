import { createLogger } from '@/observability/Logger';

import {
  createNetworkMessage,
  NetworkMessageDeduplicator,
  type NetworkMessage,
  validateNetworkMessage,
} from './NetworkMessage';
import type { PeerId } from './NetworkTypes';

export type PeerTransportHandler = (
  message: NetworkMessage,
  connection: PeerConnection,
) => Promise<void> | void;

export interface PeerConnection {
  peerId: PeerId;
  localPeerId: PeerId;
  connectedAt: number;
  lastSeenAt: number;
  send<TPayload>(
    messageType: NetworkMessage['messageType'],
    payload: TPayload,
    options?: { correlationId?: string; ttlMs?: number },
  ): Promise<void>;
}

export interface PeerTransport {
  readonly localPeerId: PeerId;
  connect(remote: PeerTransport): Promise<PeerConnection>;
  disconnect(peerId: PeerId): Promise<void>;
  send(peerId: PeerId, message: NetworkMessage): Promise<void>;
  subscribe(handler: PeerTransportHandler): () => void;
  getConnection(peerId: PeerId): PeerConnection | null;
  getConnectedPeers(): PeerId[];
}

export class InMemoryPeerTransport implements PeerTransport {
  private readonly logger = createLogger('peer.transport.memory');
  private readonly connections = new Map<PeerId, MemoryPeerConnection>();
  private readonly handlers = new Set<PeerTransportHandler>();
  private readonly deduplicator = new NetworkMessageDeduplicator();
  private remoteTransports = new Map<PeerId, InMemoryPeerTransport>();

  constructor(readonly localPeerId: PeerId) {}

  async connect(remote: PeerTransport): Promise<PeerConnection> {
    if (!(remote instanceof InMemoryPeerTransport)) {
      throw new Error('InMemoryPeerTransport can only connect to another in-memory transport');
    }

    const now = Date.now();
    const localConnection = new MemoryPeerConnection(this, remote.localPeerId, now);
    const remoteConnection = new MemoryPeerConnection(remote, this.localPeerId, now);
    this.connections.set(remote.localPeerId, localConnection);
    remote.connections.set(this.localPeerId, remoteConnection);
    this.remoteTransports.set(remote.localPeerId, remote);
    remote.remoteTransports.set(this.localPeerId, this);
    return localConnection;
  }

  async disconnect(peerId: PeerId): Promise<void> {
    const remote = this.remoteTransports.get(peerId);
    this.connections.delete(peerId);
    this.remoteTransports.delete(peerId);
    remote?.connections.delete(this.localPeerId);
    remote?.remoteTransports.delete(this.localPeerId);
  }

  async send(peerId: PeerId, message: NetworkMessage): Promise<void> {
    const remote = this.remoteTransports.get(peerId);
    if (!remote) {
      throw new Error(`Peer ${peerId} is not connected`);
    }
    await remote.receive(message, this.localPeerId);
  }

  subscribe(handler: PeerTransportHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  getConnection(peerId: PeerId): PeerConnection | null {
    return this.connections.get(peerId) ?? null;
  }

  getConnectedPeers(): PeerId[] {
    return Array.from(this.connections.keys());
  }

  private async receive(message: NetworkMessage, expectedPeerId: PeerId): Promise<void> {
    const validation = validateNetworkMessage(message);
    if (!validation.valid) {
      this.logger.warn('message_rejected', { reason: validation.error });
      return;
    }
    if (validation.message.senderId !== expectedPeerId) {
      this.logger.warn('message_rejected', { reason: 'sender-mismatch' });
      return;
    }
    if (!this.deduplicator.accept(validation.message)) {
      this.logger.warn('message_rejected', { reason: 'duplicate' });
      return;
    }

    const connection = this.connections.get(expectedPeerId);
    if (!connection) {
      this.logger.warn('message_rejected', { reason: 'missing-connection' });
      return;
    }
    connection.touch();
    for (const handler of this.handlers) {
      await handler(validation.message, connection);
    }
  }
}

class MemoryPeerConnection implements PeerConnection {
  lastSeenAt: number;

  constructor(
    private readonly transport: InMemoryPeerTransport,
    readonly peerId: PeerId,
    readonly connectedAt: number,
  ) {
    this.lastSeenAt = connectedAt;
  }

  get localPeerId(): PeerId {
    return this.transport.localPeerId;
  }

  async send<TPayload>(
    messageType: NetworkMessage['messageType'],
    payload: TPayload,
    options: { correlationId?: string; ttlMs?: number } = {},
  ): Promise<void> {
    const message = createNetworkMessage({
      messageType,
      senderId: this.localPeerId,
      payload,
      correlationId: options.correlationId,
      ttlMs: options.ttlMs,
    });
    await this.transport.send(this.peerId, message);
  }

  touch(): void {
    this.lastSeenAt = Date.now();
  }
}
