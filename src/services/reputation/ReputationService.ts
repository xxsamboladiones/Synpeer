import type { PeerId } from '../../network/NetworkTypes';

export interface ReputationConfig {
  initialScore: number;
  maxScore: number;
  minScore: number;
  decayRate: number;
  decayInterval: number;
}

export interface ReputationScore {
  peerId: PeerId;
  score: number;
  uptime: number;
  responseTime: number;
  validContent: number;
  invalidContent: number;
  spamCount: number;
  lastUpdated: number;
}

/**
 * ReputationService manages peer reputation scores
 * Peers with higher reputation get priority in the network
 */
export class ReputationService {
  private config: ReputationConfig;
  private reputations: Map<PeerId, ReputationScore>;
  private decayInterval: ReturnType<typeof globalThis.setInterval> | null = null;
  private isRunning: boolean = false;

  constructor(config: ReputationConfig) {
    this.config = {
      initialScore: config.initialScore ?? 50,
      maxScore: config.maxScore ?? 100,
      minScore: config.minScore ?? 0,
      decayRate: config.decayRate ?? 0.1,
      decayInterval: config.decayInterval ?? 3600000,
    };
    this.reputations = new Map();
  }

  /**
   * Start reputation service
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    console.log('[ReputationService] Starting reputation service');

    this.isRunning = true;
    this.startDecayLoop();
  }

  /**
   * Stop reputation service
   */
  stop(): void {
    if (!this.isRunning) return;

    console.log('[ReputationService] Stopping reputation service');

    if (this.decayInterval) {
      // eslint-disable-next-line no-undef
      clearInterval(this.decayInterval);
      this.decayInterval = null;
    }

    this.isRunning = false;
  }

  /**
   * Start decay loop
   */
  private startDecayLoop(): void {
    // eslint-disable-next-line no-undef
    this.decayInterval = setInterval(() => {
      this.applyDecay();
    }, this.config.decayInterval);
  }

  /**
   * Apply score decay to all peers
   */
  private applyDecay(): void {
    for (const [peerId, rep] of this.reputations.entries()) {
      rep.score = Math.max(this.config.minScore, rep.score - this.config.decayRate);
      rep.lastUpdated = Date.now();
      this.reputations.set(peerId, rep);
    }
  }

  /**
   * Get or create reputation for peer
   */
  private getOrCreateReputation(peerId: PeerId): ReputationScore {
    let rep = this.reputations.get(peerId);
    if (!rep) {
      rep = {
        peerId,
        score: this.config.initialScore,
        uptime: 0,
        responseTime: 0,
        validContent: 0,
        invalidContent: 0,
        spamCount: 0,
        lastUpdated: Date.now(),
      };
      this.reputations.set(peerId, rep);
    }
    return rep;
  }

  /**
   * Get reputation score for peer
   */
  getReputation(peerId: PeerId): number {
    const rep = this.reputations.get(peerId);
    return rep ? rep.score : this.config.initialScore;
  }

  /**
   * Get full reputation info
   */
  getReputationInfo(peerId: PeerId): ReputationScore | undefined {
    return this.reputations.get(peerId);
  }

  /**
   * Reward peer for uptime
   */
  rewardUptime(peerId: PeerId, duration: number): void {
    const rep = this.getOrCreateReputation(peerId);
    rep.uptime += duration;
    rep.score = Math.min(this.config.maxScore, rep.score + (duration / 3600000) * 0.5);
    rep.lastUpdated = Date.now();
    this.reputations.set(peerId, rep);
  }

  /**
   * Reward peer for fast response
   */
  rewardFastResponse(peerId: PeerId, responseTime: number): void {
    const rep = this.getOrCreateReputation(peerId);
    rep.responseTime = responseTime;

    // Reward if response time is under 1 second
    if (responseTime < 1000) {
      rep.score = Math.min(this.config.maxScore, rep.score + 1);
    }

    rep.lastUpdated = Date.now();
    this.reputations.set(peerId, rep);
  }

  /**
   * Reward peer for valid content
   */
  rewardValidContent(peerId: PeerId): void {
    const rep = this.getOrCreateReputation(peerId);
    rep.validContent++;
    rep.score = Math.min(this.config.maxScore, rep.score + 2);
    rep.lastUpdated = Date.now();
    this.reputations.set(peerId, rep);
  }

  /**
   * Penalize peer for invalid content
   */
  penalizeInvalidContent(peerId: PeerId): void {
    const rep = this.getOrCreateReputation(peerId);
    rep.invalidContent++;
    rep.score = Math.max(this.config.minScore, rep.score - 5);
    rep.lastUpdated = Date.now();
    this.reputations.set(peerId, rep);
  }

  /**
   * Penalize peer for spam
   */
  penalizeSpam(peerId: PeerId): void {
    const rep = this.getOrCreateReputation(peerId);
    rep.spamCount++;
    rep.score = Math.max(this.config.minScore, rep.score - 10);
    rep.lastUpdated = Date.now();
    this.reputations.set(peerId, rep);
  }

  /**
   * Get top N peers by reputation
   */
  getTopPeers(count: number): PeerId[] {
    return Array.from(this.reputations.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, count)
      .map((rep) => rep.peerId);
  }

  /**
   * Get all peers sorted by reputation
   */
  getAllPeersSorted(): ReputationScore[] {
    return Array.from(this.reputations.values()).sort((a, b) => b.score - a.score);
  }

  /**
   * Check if peer is trusted (score > 50)
   */
  isTrusted(peerId: PeerId): boolean {
    return this.getReputation(peerId) > 50;
  }

  /**
   * Check if peer is suspicious (score < 30)
   */
  isSuspicious(peerId: PeerId): boolean {
    return this.getReputation(peerId) < 30;
  }

  /**
   * Remove peer reputation
   */
  removePeer(peerId: PeerId): void {
    this.reputations.delete(peerId);
  }

  /**
   * Get peer count
   */
  getPeerCount(): number {
    return this.reputations.size;
  }

  /**
   * Get average reputation
   */
  getAverageReputation(): number {
    const scores = Array.from(this.reputations.values()).map((r) => r.score);
    if (scores.length === 0) return this.config.initialScore;
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }
}
