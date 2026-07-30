import type { PeerId } from '../../network/NetworkTypes';

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  cleanupInterval: number;
}

export interface RateLimitEntry {
  peerId: PeerId;
  requests: number[];
  windowStart: number;
  blocked: boolean;
  blockedUntil: number;
}

/**
 * RateLimitingService limits requests per peer to prevent abuse
 * Default: 100 requests per minute per peer
 */
export class RateLimitingService {
  private config: RateLimitConfig;
  private rateLimits: Map<PeerId, RateLimitEntry>;
  private cleanupInterval: ReturnType<typeof globalThis.setInterval> | null = null;
  private isRunning: boolean = false;

  constructor(config: RateLimitConfig) {
    this.config = {
      maxRequests: config.maxRequests ?? 100,
      windowMs: config.windowMs ?? 60000,
      cleanupInterval: config.cleanupInterval ?? 60000,
    };
    this.rateLimits = new Map();
  }

  /**
   * Start rate limiting service
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    console.log('[RateLimitingService] Starting rate limiting');

    this.isRunning = true;
    this.startCleanupLoop();
  }

  /**
   * Stop rate limiting service
   */
  stop(): void {
    if (!this.isRunning) return;

    console.log('[RateLimitingService] Stopping rate limiting');

    if (this.cleanupInterval) {
      // eslint-disable-next-line no-undef
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    this.isRunning = false;
  }

  /**
   * Start cleanup loop
   */
  private startCleanupLoop(): void {
    // eslint-disable-next-line no-undef
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldEntries();
    }, this.config.cleanupInterval);
  }

  /**
   * Check if peer is rate limited
   */
  isRateLimited(peerId: PeerId): boolean {
    const entry = this.rateLimits.get(peerId);
    if (!entry) return false;

    const now = Date.now();

    // Check if block has expired
    if (entry.blocked && now > entry.blockedUntil) {
      entry.blocked = false;
      entry.blockedUntil = 0;
      this.rateLimits.set(peerId, entry);
      return false;
    }

    return entry.blocked;
  }

  /**
   * Record a request from peer
   */
  recordRequest(peerId: PeerId): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    let entry = this.rateLimits.get(peerId);

    if (!entry) {
      entry = {
        peerId,
        requests: [],
        windowStart: now,
        blocked: false,
        blockedUntil: 0,
      };
      this.rateLimits.set(peerId, entry);
    }

    // Check if window has expired
    if (now - entry.windowStart > this.config.windowMs) {
      entry.requests = [];
      entry.windowStart = now;
    }

    // Check if peer is blocked
    if (entry.blocked && now < entry.blockedUntil) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: entry.blockedUntil,
      };
    }

    // Add request timestamp
    entry.requests.push(now);

    // Check if limit exceeded
    if (entry.requests.length > this.config.maxRequests) {
      entry.blocked = true;
      entry.blockedUntil = now + this.config.windowMs;
      this.rateLimits.set(peerId, entry);

      return {
        allowed: false,
        remaining: 0,
        resetAt: entry.blockedUntil,
      };
    }

    this.rateLimits.set(peerId, entry);

    return {
      allowed: true,
      remaining: this.config.maxRequests - entry.requests.length,
      resetAt: entry.windowStart + this.config.windowMs,
    };
  }

  /**
   * Get rate limit info for peer
   */
  getRateLimitInfo(peerId: PeerId): RateLimitEntry | undefined {
    return this.rateLimits.get(peerId);
  }

  /**
   * Reset rate limit for peer
   */
  resetRateLimit(peerId: PeerId): void {
    const entry = this.rateLimits.get(peerId);
    if (entry) {
      entry.requests = [];
      entry.windowStart = Date.now();
      entry.blocked = false;
      entry.blockedUntil = 0;
      this.rateLimits.set(peerId, entry);
    }
  }

  /**
   * Cleanup old entries
   */
  private cleanupOldEntries(): void {
    const now = Date.now();
    let removed = 0;

    for (const [peerId, entry] of this.rateLimits.entries()) {
      // Remove entries that are not blocked and have no recent requests
      const timeSinceWindow = now - entry.windowStart;
      if (!entry.blocked && timeSinceWindow > this.config.windowMs * 2) {
        this.rateLimits.delete(peerId);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`[RateLimitingService] Cleaned ${removed} old entries`);
    }
  }

  /**
   * Get statistics
   */
  getStatistics(): { totalPeers: number; blockedPeers: number; totalRequests: number } {
    const entries = Array.from(this.rateLimits.values());
    const blockedPeers = entries.filter((e) => e.blocked).length;
    const totalRequests = entries.reduce((sum, e) => sum + e.requests.length, 0);

    return {
      totalPeers: entries.length,
      blockedPeers,
      totalRequests,
    };
  }

  /**
   * Clear all rate limits
   */
  clearAll(): void {
    this.rateLimits.clear();
  }
}
