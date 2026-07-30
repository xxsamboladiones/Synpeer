import type { PeerId } from './NetworkTypes';

interface ManagedStream {
  send: (data: Uint8Array) => boolean;
  close: () => Promise<void>;
  abort?: (error: Error) => void;
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
}

type StreamOpener = (peerId: PeerId, protocol: string) => Promise<ManagedStream>;

/**
 * Stream configuration
 */
export interface StreamConfig {
  /** Stream protocol name */
  protocol: string;
  /** Maximum stream lifetime in milliseconds */
  maxLifetime: number;
  /** Stream timeout in milliseconds */
  timeout: number;
  /** Keep-alive interval in milliseconds */
  keepAliveInterval: number;
  /** Maximum concurrent streams per peer */
  maxConcurrentStreams: number;
  /** Flow control window size in bytes */
  flowControlWindow: number;
  /** Maximum bytes per second per stream */
  maxBytesPerSecond: number;
  /** Maximum retry attempts */
  maxRetries: number;
  /** Retry delay in milliseconds */
  retryDelay: number;
}

/**
 * Default stream configuration
 */
export const defaultStreamConfig: StreamConfig = {
  protocol: '/synpeer/chunk/1.0.0',
  maxLifetime: 300000, // 5 minutes
  timeout: 30000, // 30 seconds
  keepAliveInterval: 10000, // 10 seconds
  maxConcurrentStreams: 10,
  flowControlWindow: 1024 * 1024, // 1MB
  maxBytesPerSecond: 1024 * 1024, // 1MB/s
  maxRetries: 3,
  retryDelay: 1000, // 1 second
};

/**
 * Stream state
 */
export interface StreamState {
  /** Stream ID */
  id: string;
  /** Peer ID */
  peerId: PeerId;
  /** Protocol */
  protocol: string;
  /** Created timestamp */
  createdAt: number;
  /** Last activity timestamp */
  lastActivity: number;
  /** Bytes sent */
  bytesSent: number;
  /** Bytes received */
  bytesReceived: number;
  /** Stream status */
  status: 'active' | 'closing' | 'closed' | 'error' | 'cancelled';
  /** Error message if status is error */
  error?: string;
  /** Flow control window bytes sent */
  windowBytesSent: number;
  /** Last rate limit reset timestamp */
  lastRateLimitReset: number;
  /** Cancelled flag */
  cancelled: boolean;
  /** Retry count */
  retryCount: number;
  /** Last retry timestamp */
  lastRetryTimestamp: number;
}

/**
 * Stream manager handles libp2p streams
 */
export class StreamManager {
  private config: StreamConfig;
  private streams: Map<string, StreamState> = new Map();
  private peerStreams: Map<PeerId, Set<string>> = new Map();
  private managedStreams: Map<string, ManagedStream> = new Map();
  private streamCounter: number = 0;
  private streamOpener: StreamOpener | null = null;

  constructor(config: StreamConfig = defaultStreamConfig) {
    this.config = config;
  }

  setStreamOpener(opener: StreamOpener): void {
    this.streamOpener = opener;
  }

  /**
   * Generate unique stream ID
   */
  private generateStreamId(peerId: PeerId): string {
    this.streamCounter++;
    return `stream_${peerId}_${Date.now()}_${this.streamCounter}`;
  }

  /**
   * Open a new stream to a peer
   */
  async openStream(peerId: PeerId, protocol?: string): Promise<string> {
    const streamId = this.generateStreamId(peerId);
    const streamProtocol = protocol || this.config.protocol;

    // Check peer stream limit
    const peerStreamCount = this.peerStreams.get(peerId)?.size || 0;
    if (peerStreamCount >= this.config.maxConcurrentStreams) {
      throw new Error(
        `Maximum concurrent streams (${this.config.maxConcurrentStreams}) reached for peer ${peerId}`,
      );
    }

    // Create stream state
    const streamState: StreamState = {
      id: streamId,
      peerId,
      protocol: streamProtocol,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      bytesSent: 0,
      bytesReceived: 0,
      status: 'active',
      windowBytesSent: 0,
      lastRateLimitReset: Date.now(),
      cancelled: false,
      retryCount: 0,
      lastRetryTimestamp: 0,
    };

    this.streams.set(streamId, streamState);

    // Track peer streams
    if (!this.peerStreams.has(peerId)) {
      this.peerStreams.set(peerId, new Set());
    }
    this.peerStreams.get(peerId)!.add(streamId);

    if (this.streamOpener) {
      try {
        const managedStream = await this.streamOpener(peerId, streamProtocol);
        this.managedStreams.set(streamId, managedStream);
        managedStream.addEventListener?.('message', (event: unknown) => {
          const data = (event as unknown as { data: Uint8Array | { subarray: () => Uint8Array } })
            .data;
          const bytes = data instanceof Uint8Array ? data : data.subarray();
          this.receiveData(streamId, bytes).catch((error) => {
            console.error(
              `[StreamManager] Failed to process incoming stream data for ${streamId}:`,
              error,
            );
          });
        });
      } catch (error) {
        streamState.status = 'error';
        streamState.error = error instanceof Error ? error.message : 'Failed to open stream';
        this.cleanupStream(streamId);
        throw error;
      }
    }

    // Start keep-alive timer
    this.startKeepAlive(streamId);

    // Start timeout timer
    this.startTimeout(streamId);

    return streamId;
  }

  /**
   * Close a stream
   */
  async closeStream(streamId: string): Promise<void> {
    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new Error(`Stream ${streamId} not found`);
    }

    if (stream.status === 'closed') {
      return;
    }

    stream.status = 'closing';

    const managedStream = this.managedStreams.get(streamId);
    if (managedStream) {
      await managedStream.close();
    }

    stream.status = 'closed';
    this.cleanupStream(streamId);
  }

  /**
   * Send data through a stream with retry logic
   */
  async sendData(streamId: string, data: Uint8Array): Promise<void> {
    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new Error(`Stream ${streamId} not found`);
    }

    if (stream.status !== 'active') {
      throw new Error(`Stream ${streamId} is not active (status: ${stream.status})`);
    }

    if (stream.cancelled) {
      throw new Error(`Stream ${streamId} is cancelled`);
    }

    // Check flow control window
    if (stream.windowBytesSent + data.length > this.config.flowControlWindow) {
      // Reset window if enough time has passed
      const timeSinceReset = Date.now() - stream.lastRateLimitReset;
      if (timeSinceReset >= 1000) {
        stream.windowBytesSent = 0;
        stream.lastRateLimitReset = Date.now();
      } else {
        throw new Error(`Flow control window exceeded for stream ${streamId}`);
      }
    }

    // Check rate limit
    const timeSinceReset = Date.now() - stream.lastRateLimitReset;
    if (timeSinceReset >= 1000) {
      stream.windowBytesSent = 0;
      stream.lastRateLimitReset = Date.now();
    }

    if (stream.windowBytesSent + data.length > this.config.maxBytesPerSecond) {
      throw new Error(`Rate limit exceeded for stream ${streamId}`);
    }

    // Attempt to send data with retry logic
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const managedStream = this.managedStreams.get(streamId);
        if (managedStream) {
          const accepted = managedStream.send(data);
          if (!accepted) {
            throw new Error(`Stream ${streamId} write buffer is full`);
          }
        }

        stream.bytesSent += data.length;
        stream.windowBytesSent += data.length;
        stream.lastActivity = Date.now();

        // Reset retry count on success
        stream.retryCount = 0;
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        stream.retryCount = attempt + 1;
        stream.lastRetryTimestamp = Date.now();

        if (attempt < this.config.maxRetries) {
          console.warn(
            `[StreamManager] Send failed for stream ${streamId}, retrying in ${this.config.retryDelay}ms (attempt ${attempt + 1}/${this.config.maxRetries})`,
          );
          await new Promise((resolve) => globalThis.setTimeout(resolve, this.config.retryDelay));
        }
      }
    }

    // All retries failed
    stream.status = 'error';
    stream.error = lastError?.message || 'Unknown error';
    throw lastError || new Error(`Failed to send data after ${this.config.maxRetries} retries`);
  }

  /**
   * Retry a failed stream
   */
  async retryStream(streamId: string): Promise<void> {
    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new Error(`Stream ${streamId} not found`);
    }

    if (stream.status !== 'error') {
      throw new Error(`Stream ${streamId} is not in error state (status: ${stream.status})`);
    }

    if (stream.retryCount >= this.config.maxRetries) {
      throw new Error(`Stream ${streamId} has exceeded maximum retry attempts`);
    }

    console.log(
      `[StreamManager] Retrying stream ${streamId} (retry ${stream.retryCount + 1}/${this.config.maxRetries})`,
    );

    // Reset stream state for retry
    stream.status = 'active';
    stream.error = undefined;
    stream.lastRetryTimestamp = Date.now();
    stream.lastActivity = Date.now();

    const managedStream = await this.streamOpener?.(stream.peerId, stream.protocol);
    if (managedStream) {
      this.managedStreams.set(streamId, managedStream);
    }
  }

  /**
   * Cancel a stream
   */
  async cancelStream(streamId: string): Promise<void> {
    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new Error(`Stream ${streamId} not found`);
    }

    if (stream.status === 'closed' || stream.status === 'cancelled') {
      return;
    }

    stream.cancelled = true;
    stream.status = 'cancelled';

    this.managedStreams.get(streamId)?.abort?.(new Error(`Stream ${streamId} cancelled`));

    this.cleanupStream(streamId);
  }

  /**
   * Receive data from a stream
   */
  async receiveData(streamId: string, data: Uint8Array): Promise<void> {
    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new Error(`Stream ${streamId} not found`);
    }

    if (stream.status !== 'active') {
      throw new Error(`Stream ${streamId} is not active (status: ${stream.status})`);
    }

    stream.bytesReceived += data.length;
    stream.lastActivity = Date.now();
  }

  /**
   * Start keep-alive timer for a stream
   */
  private startKeepAlive(streamId: string): void {
    const keepAliveInterval = globalThis.setInterval(() => {
      const stream = this.streams.get(streamId);
      if (!stream || stream.status !== 'active') {
        globalThis.clearInterval(keepAliveInterval);
        return;
      }

      stream.lastActivity = Date.now();
    }, this.config.keepAliveInterval);
  }

  /**
   * Start timeout timer for a stream
   */
  private startTimeout(streamId: string): void {
    globalThis.setTimeout(() => {
      const stream = this.streams.get(streamId);
      if (!stream || stream.status !== 'active') {
        return;
      }

      const idleTime = Date.now() - stream.lastActivity;
      if (idleTime > this.config.timeout) {
        console.warn(`[StreamManager] Stream ${streamId} timed out after ${idleTime}ms`);
        this.closeStream(streamId).catch((error) => {
          console.error(`[StreamManager] Failed to close timed out stream ${streamId}:`, error);
        });
      }
    }, this.config.timeout);
  }

  /**
   * Cleanup stream resources
   */
  private cleanupStream(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return;
    }

    // Remove from peer streams
    const peerStreams = this.peerStreams.get(stream.peerId);
    if (peerStreams) {
      peerStreams.delete(streamId);
      if (peerStreams.size === 0) {
        this.peerStreams.delete(stream.peerId);
      }
    }

    // Remove from streams
    this.streams.delete(streamId);
    this.managedStreams.delete(streamId);
  }

  /**
   * Get stream state
   */
  getStreamState(streamId: string): StreamState | null {
    return this.streams.get(streamId) || null;
  }

  /**
   * Get all streams for a peer
   */
  getPeerStreams(peerId: PeerId): StreamState[] {
    const peerStreamIds = this.peerStreams.get(peerId);
    if (!peerStreamIds) {
      return [];
    }

    const streams: StreamState[] = [];
    for (const streamId of peerStreamIds) {
      const stream = this.streams.get(streamId);
      if (stream) {
        streams.push(stream);
      }
    }

    return streams;
  }

  /**
   * Get all active streams
   */
  getAllStreams(): StreamState[] {
    return Array.from(this.streams.values()).filter((s) => s.status === 'active');
  }

  /**
   * Get stream count
   */
  getStreamCount(): number {
    return this.streams.size;
  }

  /**
   * Get peer stream count
   */
  getPeerStreamCount(peerId: PeerId): number {
    return this.peerStreams.get(peerId)?.size || 0;
  }

  /**
   * Close all streams for a peer
   */
  async closePeerStreams(peerId: PeerId): Promise<void> {
    const peerStreamIds = this.peerStreams.get(peerId);
    if (!peerStreamIds) {
      return;
    }

    const closePromises = Array.from(peerStreamIds).map((streamId) =>
      this.closeStream(streamId).catch((error) => {
        console.error(`[StreamManager] Failed to close stream ${streamId}:`, error);
      }),
    );

    await Promise.all(closePromises);
  }

  /**
   * Close all streams
   */
  async closeAllStreams(): Promise<void> {
    const streamIds = Array.from(this.streams.keys());
    const closePromises = streamIds.map((streamId) =>
      this.closeStream(streamId).catch((error) => {
        console.error(`[StreamManager] Failed to close stream ${streamId}:`, error);
      }),
    );

    await Promise.all(closePromises);
  }

  /**
   * Get stream statistics
   */
  getStatistics(): {
    totalStreams: number;
    activeStreams: number;
    totalBytesSent: number;
    totalBytesReceived: number;
    byPeer: Map<PeerId, number>;
  } {
    const streams = Array.from(this.streams.values());
    const activeStreams = streams.filter((s) => s.status === 'active');
    const totalBytesSent = streams.reduce((sum, s) => sum + s.bytesSent, 0);
    const totalBytesReceived = streams.reduce((sum, s) => sum + s.bytesReceived, 0);

    const byPeer = new Map<PeerId, number>();
    for (const stream of streams) {
      const count = byPeer.get(stream.peerId) || 0;
      byPeer.set(stream.peerId, count + 1);
    }

    return {
      totalStreams: streams.length,
      activeStreams: activeStreams.length,
      totalBytesSent,
      totalBytesReceived,
      byPeer,
    };
  }
}
