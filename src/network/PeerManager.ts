import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { bootstrap } from '@libp2p/bootstrap';

import type { NetworkConfig, PeerId, PeerInfo } from './NetworkTypes';
import { defaultNetworkConfig } from './networkConfig';
import { StreamManager, defaultStreamConfig } from './StreamManager';

export interface IncomingStreamMessage {
  protocol: string;
  peerId: PeerId;
  data: Uint8Array;
}

export type IncomingStreamHandler = (message: IncomingStreamMessage) => Promise<void> | void;

/**
 * PeerManager manages the libp2p node and peer connections
 */
export class PeerManager {
  private libp2pNode: Awaited<ReturnType<typeof createLibp2p>> | null = null;
  private config: NetworkConfig;
  private startTime: number = 0;
  private streamManager: StreamManager;
  private protocolHandlers: Set<string> = new Set();

  constructor(config: NetworkConfig = defaultNetworkConfig) {
    this.config = config;
    this.streamManager = new StreamManager(defaultStreamConfig);
  }

  /**
   * Initialize the libp2p node
   */
  async initialize(): Promise<void> {
    if (this.libp2pNode) {
      throw new Error('PeerManager already initialized');
    }

    this.startTime = Date.now();

    // Configure libp2p with transports and security
    const node = await createLibp2p({
      addresses: {
        listen: ['/ip4/0.0.0.0/tcp/0'],
      },
      transports: [tcp(), webSockets()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery:
        this.config.bootstrapPeers.length > 0
          ? [bootstrap({ list: this.config.bootstrapPeers })]
          : [],
    });

    this.libp2pNode = node;
    this.streamManager.setStreamOpener(async (peerId, protocol) => {
      if (!this.libp2pNode) {
        throw new Error('PeerManager not initialized');
      }

      return (await this.libp2pNode.dialProtocol(peerId as never, protocol)) as never;
    });

    // Event listeners
    this.setupEventListeners();

    await node.start();
  }

  /**
   * Setup event listeners for libp2p events
   */
  private setupEventListeners(): void {
    if (!this.libp2pNode) return;

    this.libp2pNode.addEventListener('peer:connect', (event: unknown) => {
      if (this.config.debug) {
        const detail = (event as { detail: { toString: () => string } }).detail;
        console.log('[PeerManager] Peer connected:', detail?.toString?.() ?? 'unknown');
      }
    });

    this.libp2pNode.addEventListener('peer:disconnect', (event: unknown) => {
      if (this.config.debug) {
        const detail = (event as { detail: { toString: () => string } }).detail;
        console.log('[PeerManager] Peer disconnected:', detail?.toString?.() ?? 'unknown');
      }
    });
  }

  /**
   * Get the local peer ID
   */
  getPeerId(): PeerId | null {
    return this.libp2pNode?.peerId?.toString() ?? null;
  }

  /**
   * Get connected peers
   */
  getConnectedPeers(): PeerInfo[] {
    if (!this.libp2pNode) return [];

    const connections = this.libp2pNode.getConnections();
    return connections.map((conn: unknown) => {
      const connection = conn as {
        remotePeer: { toString: () => string };
        remoteAddr?: { toString: () => string };
      };
      return {
        id: connection.remotePeer.toString(),
        addresses: connection.remoteAddr ? [connection.remoteAddr.toString()] : [],
        connected: true,
        lastSeen: Date.now(),
      };
    });
  }

  getListenAddresses(): string[] {
    if (!this.libp2pNode) {
      return [];
    }

    return this.libp2pNode
      .getMultiaddrs()
      .map((address: { toString: () => string }) => address.toString());
  }

  /**
   * Connect to a specific peer
   */
  async connectToPeer(multiaddr: string): Promise<void> {
    if (!this.libp2pNode) {
      throw new Error('PeerManager not initialized');
    }

    // Use multiaddr for dialing
    const { multiaddr: multiaddrUtil } = await import('@multiformats/multiaddr');
    const addr = multiaddrUtil(multiaddr);
    await this.libp2pNode.dial(addr);
  }

  async handleProtocol(
    protocol: string,
    handler: IncomingStreamHandler,
  ): Promise<() => Promise<void>> {
    if (!this.libp2pNode) {
      throw new Error('PeerManager not initialized');
    }

    await this.libp2pNode.handle(
      protocol,
      async (stream, connection) => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of stream) {
          chunks.push(this.toUint8Array(chunk));
        }

        const totalSize = chunks.reduce((total, chunk) => total + chunk.length, 0);
        const data = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.length;
        }

        await handler({
          protocol,
          peerId: connection.remotePeer.toString(),
          data,
        });
      },
      { force: true },
    );

    this.protocolHandlers.add(protocol);

    return async () => {
      if (this.libp2pNode && this.protocolHandlers.has(protocol)) {
        await this.libp2pNode.unhandle(protocol);
        this.protocolHandlers.delete(protocol);
      }
    };
  }

  /**
   * Stop the libp2p node
   */
  async stop(): Promise<void> {
    if (this.libp2pNode) {
      // Close all streams before stopping
      await this.streamManager.closeAllStreams();
      for (const protocol of this.protocolHandlers) {
        await this.libp2pNode.unhandle(protocol);
      }
      this.protocolHandlers.clear();
      await this.libp2pNode.stop();
      this.libp2pNode = null;
    }
  }

  /**
   * Get the stream manager
   */
  getStreamManager(): StreamManager {
    return this.streamManager;
  }

  /**
   * Open a stream to a peer
   */
  async openStream(peerId: PeerId, protocol?: string): Promise<string> {
    if (!this.libp2pNode) {
      throw new Error('PeerManager not initialized');
    }

    return await this.streamManager.openStream(peerId, protocol);
  }

  /**
   * Close a stream
   */
  async closeStream(streamId: string): Promise<void> {
    await this.streamManager.closeStream(streamId);
  }

  /**
   * Cancel a stream
   */
  async cancelStream(streamId: string): Promise<void> {
    await this.streamManager.cancelStream(streamId);
  }

  /**
   * Send data through a stream
   */
  async sendStreamData(streamId: string, data: Uint8Array): Promise<void> {
    await this.streamManager.sendData(streamId, data);
  }

  /**
   * Receive data from a stream
   */
  async receiveStreamData(streamId: string, data: Uint8Array): Promise<void> {
    await this.streamManager.receiveData(streamId, data);
  }

  /**
   * Check if the node is running
   */
  isRunning(): boolean {
    return this.libp2pNode !== null;
  }

  /**
   * Get network uptime in milliseconds
   */
  getUptime(): number {
    return this.startTime > 0 ? Date.now() - this.startTime : 0;
  }

  getBootstrapPeers(): readonly string[] {
    return this.config.bootstrapPeers;
  }

  private toUint8Array(chunk: unknown): Uint8Array {
    if (chunk instanceof Uint8Array) {
      return chunk;
    }

    const maybeList = chunk as { subarray?: () => Uint8Array };
    if (typeof maybeList.subarray === 'function') {
      return maybeList.subarray();
    }

    return new Uint8Array();
  }
}
