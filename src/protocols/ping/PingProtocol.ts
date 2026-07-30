import type { PeerId } from '../../network/NetworkTypes';

/**
 * Ping protocol message types
 */
export type PingMessageType = 'PING' | 'PONG';

/**
 * Base ping message
 */
export interface PingMessage {
  type: PingMessageType;
  timestamp: number;
  peerId: PeerId;
}

/**
 * Ping request
 */
export interface PingRequest extends PingMessage {
  type: 'PING';
  sequence: number;
}

/**
 * Pong response
 */
export interface PongResponse extends PingMessage {
  type: 'PONG';
  sequence: number;
  originalTimestamp: number;
}

/**
 * Ping result
 */
export interface PingResult {
  peerId: PeerId;
  latency: number; // in milliseconds
  sequence: number;
  timestamp: number;
  success: boolean;
  error?: string;
}

/**
 * Ping protocol configuration
 */
export interface PingConfig {
  /** Ping interval in milliseconds */
  pingInterval: number;
  /** Ping timeout in milliseconds */
  pingTimeout: number;
  /** Maximum consecutive failures before marking peer as unavailable */
  maxFailures: number;
}

/**
 * Default ping configuration
 */
export const defaultPingConfig: PingConfig = {
  pingInterval: 30000, // 30 seconds
  pingTimeout: 5000, // 5 seconds
  maxFailures: 3,
};

/**
 * PingProtocol handles ping/pong for latency measurement and availability detection
 */
export class PingProtocol {
  private config: PingConfig;
  private sequence: number = 0;
  private pendingPings: Map<number, { peerId: PeerId; timestamp: number }> = new Map();
  private pingResults: Map<PeerId, PingResult[]> = new Map();
  private failureCount: Map<PeerId, number> = new Map();
  private pingInterval: ReturnType<typeof globalThis.setInterval> | null = null;

  constructor(config: PingConfig = defaultPingConfig) {
    this.config = config;
  }

  /**
   * Create a ping request
   */
  createPingRequest(peerId: PeerId): PingRequest {
    this.sequence++;
    return {
      type: 'PING',
      timestamp: Date.now(),
      peerId,
      sequence: this.sequence,
    };
  }

  /**
   * Create a pong response
   */
  createPongResponse(pingRequest: PingRequest, localPeerId: PeerId): PongResponse {
    return {
      type: 'PONG',
      timestamp: Date.now(),
      peerId: localPeerId,
      sequence: pingRequest.sequence,
      originalTimestamp: pingRequest.timestamp,
    };
  }

  /**
   * Handle incoming ping request
   */
  handlePingRequest(pingRequest: PingRequest, localPeerId: PeerId): PongResponse {
    return this.createPongResponse(pingRequest, localPeerId);
  }

  /**
   * Handle incoming pong response
   */
  handlePongResponse(pongResponse: PongResponse): PingResult | null {
    const pending = this.pendingPings.get(pongResponse.sequence);

    if (!pending) {
      return null; // No matching ping request
    }

    if (pending.peerId !== pongResponse.peerId) {
      return null; // Peer ID mismatch
    }

    // Calculate latency
    const latency = Date.now() - pongResponse.originalTimestamp;

    // Remove from pending
    this.pendingPings.delete(pongResponse.sequence);

    // Reset failure count
    this.failureCount.set(pongResponse.peerId, 0);

    // Store result
    const result: PingResult = {
      peerId: pongResponse.peerId,
      latency,
      sequence: pongResponse.sequence,
      timestamp: Date.now(),
      success: true,
    };

    this.addPingResult(result);

    return result;
  }

  /**
   * Send ping to a peer
   */
  async sendPing(
    peerId: PeerId,
    sendFunction: (message: PingRequest) => Promise<void>,
  ): Promise<PingResult> {
    const pingRequest = this.createPingRequest(peerId);

    // Store pending ping
    this.pendingPings.set(pingRequest.sequence, {
      peerId,
      timestamp: Date.now(),
    });

    try {
      // Send ping
      await sendFunction(pingRequest);

      // Wait for pong with timeout
      const result = await this.waitForPong(pingRequest.sequence, this.config.pingTimeout);

      if (result) {
        return result;
      }

      // Timeout
      this.pendingPings.delete(pingRequest.sequence);
      this.incrementFailureCount(peerId);

      return {
        peerId,
        latency: this.config.pingTimeout,
        sequence: pingRequest.sequence,
        timestamp: Date.now(),
        success: false,
        error: 'Ping timeout',
      };
    } catch (error) {
      this.pendingPings.delete(pingRequest.sequence);
      this.incrementFailureCount(peerId);

      return {
        peerId,
        latency: this.config.pingTimeout,
        sequence: pingRequest.sequence,
        timestamp: Date.now(),
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Wait for pong response
   */
  private async waitForPong(sequence: number, timeout: number): Promise<PingResult | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const result = this.getPingResultBySequence(sequence);
      if (result) {
        return result;
      }

      // Sleep for 50ms
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }

    return null;
  }

  /**
   * Get ping result by sequence number
   */
  private getPingResultBySequence(sequence: number): PingResult | null {
    for (const results of this.pingResults.values()) {
      const result = results.find((r) => r.sequence === sequence);
      if (result) {
        return result;
      }
    }
    return null;
  }

  /**
   * Add ping result
   */
  private addPingResult(result: PingResult): void {
    if (!this.pingResults.has(result.peerId)) {
      this.pingResults.set(result.peerId, []);
    }

    const results = this.pingResults.get(result.peerId)!;
    results.push(result);

    // Keep only last 100 results
    if (results.length > 100) {
      results.shift();
    }
  }

  /**
   * Increment failure count for a peer
   */
  private incrementFailureCount(peerId: PeerId): void {
    const currentCount = this.failureCount.get(peerId) ?? 0;
    this.failureCount.set(peerId, currentCount + 1);
  }

  /**
   * Get failure count for a peer
   */
  getFailureCount(peerId: PeerId): number {
    return this.failureCount.get(peerId) ?? 0;
  }

  /**
   * Check if peer is available
   */
  isPeerAvailable(peerId: PeerId): boolean {
    return (this.failureCount.get(peerId) ?? 0) < this.config.maxFailures;
  }

  /**
   * Get ping results for a peer
   */
  getPingResults(peerId: PeerId): PingResult[] {
    return this.pingResults.get(peerId) ?? [];
  }

  /**
   * Get average latency for a peer
   */
  getAverageLatency(peerId: PeerId): number | null {
    const results = this.getPingResults(peerId);
    const successfulResults = results.filter((r) => r.success);

    if (successfulResults.length === 0) {
      return null;
    }

    const totalLatency = successfulResults.reduce((sum, r) => sum + r.latency, 0);
    return totalLatency / successfulResults.length;
  }

  /**
   * Start periodic pinging
   */
  startPeriodicPing(
    peerIds: PeerId[],
    sendFunction: (peerId: PeerId, message: PingRequest) => Promise<void>,
  ): void {
    if (this.pingInterval) {
      return; // Already running
    }

    // eslint-disable-next-line no-undef
    this.pingInterval = setInterval(() => {
      for (const peerId of peerIds) {
        this.sendPing(peerId, (message) => sendFunction(peerId, message)).catch(() => {
          // Error is handled in sendPing
        });
      }
    }, this.config.pingInterval);
  }

  /**
   * Stop periodic pinging
   */
  stopPeriodicPing(): void {
    if (this.pingInterval) {
      // eslint-disable-next-line no-undef
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Clear ping results for a peer
   */
  clearPingResults(peerId: PeerId): void {
    this.pingResults.delete(peerId);
    this.failureCount.delete(peerId);
  }

  /**
   * Clear all ping results
   */
  clearAllPingResults(): void {
    this.pingResults.clear();
    this.failureCount.clear();
    this.pendingPings.clear();
  }

  /**
   * Cleanup
   */
  cleanup(): void {
    this.stopPeriodicPing();
    this.clearAllPingResults();
  }
}
