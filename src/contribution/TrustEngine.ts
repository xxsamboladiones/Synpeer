import type { PeerId } from '../network/NetworkTypes';
import type { TrustScore, TrustThresholds } from './ContributionTypes';
import { defaultTrustThresholds } from './ContributionTypes';
import { createLogger } from '../observability/Logger';
import type { Clock } from '../time/Clock';
import { systemClock } from '../time/Clock';

export interface TrustPolicy {
  minScore: number;
  maxScore: number;
  successDelta: number;
  failureDelta: number;
  connectionDelta: number;
  disconnectionDelta: number;
  highAvailabilityDelta: number;
  goodAvailabilityDelta: number;
  lowAvailabilityDelta: number;
}

export const defaultTrustPolicy: TrustPolicy = {
  minScore: 0,
  maxScore: 1000,
  successDelta: 10,
  failureDelta: -20,
  connectionDelta: 5,
  disconnectionDelta: -10,
  highAvailabilityDelta: 15,
  goodAvailabilityDelta: 10,
  lowAvailabilityDelta: -25,
};

export type TrustObservationType =
  'success' | 'failure' | 'connected' | 'disconnected' | 'availability';

/**
 * TrustEngine calculates peer trust scores
 */
export class TrustEngine {
  private trustScores: Map<PeerId, TrustScore> = new Map();
  private responseTimes: Map<PeerId, number[]> = new Map();
  private processedEvents: Set<string> = new Set();
  private thresholds: TrustThresholds;
  private readonly logger = createLogger('trust.engine');

  constructor(
    thresholds: TrustThresholds = defaultTrustThresholds,
    private readonly policy: TrustPolicy = defaultTrustPolicy,
    private readonly clock: Clock = systemClock,
  ) {
    validateTrustPolicy(policy);
    this.thresholds = thresholds;
  }

  /**
   * Get trust score for a peer
   */
  getTrustScore(peerId: PeerId): TrustScore {
    if (!this.trustScores.has(peerId)) {
      this.trustScores.set(peerId, {
        peerId,
        score: 500, // Start with neutral score
        availability: 0,
        latency: 0,
        successfulResponses: 0,
        failedResponses: 0,
        lastUpdated: this.clock.now(),
      });
    }
    return this.trustScores.get(peerId)!;
  }

  /**
   * Record successful response
   */
  recordSuccessfulResponse(peerId: PeerId, responseTime: number): void {
    if (!Number.isFinite(responseTime) || responseTime < 0) {
      return;
    }
    const trust = this.getTrustScore(peerId);
    trust.successfulResponses += 1;
    trust.lastUpdated = this.clock.now();

    // Update response time tracking
    if (!this.responseTimes.has(peerId)) {
      this.responseTimes.set(peerId, []);
    }
    const times = this.responseTimes.get(peerId)!;
    times.push(responseTime);

    // Keep only last 100 response times
    if (times.length > 100) {
      times.shift();
    }

    // Recalculate latency
    trust.latency = this.calculateAverageLatency(times);

    // Increase trust score
    this.adjustTrustScore(peerId, this.policy.successDelta);
  }

  /**
   * Record failed response
   */
  recordFailedResponse(peerId: PeerId): void {
    const trust = this.getTrustScore(peerId);
    trust.failedResponses += 1;
    trust.lastUpdated = this.clock.now();

    // Decrease trust score
    this.adjustTrustScore(peerId, this.policy.failureDelta);
  }

  /**
   * Record peer connection
   */
  recordPeerConnection(peerId: PeerId): void {
    const trust = this.getTrustScore(peerId);
    trust.lastUpdated = this.clock.now();

    // Slightly increase trust for being available
    this.adjustTrustScore(peerId, this.policy.connectionDelta);
  }

  /**
   * Record peer disconnection
   */
  recordPeerDisconnection(peerId: PeerId): void {
    const trust = this.getTrustScore(peerId);
    trust.lastUpdated = this.clock.now();

    // Decrease trust for disconnecting
    this.adjustTrustScore(peerId, this.policy.disconnectionDelta);
  }

  /**
   * Update availability
   */
  updateAvailability(peerId: PeerId, availability: number): void {
    const trust = this.getTrustScore(peerId);
    if (!Number.isFinite(availability)) {
      return;
    }
    trust.availability = Math.max(0, Math.min(100, availability));
    trust.lastUpdated = this.clock.now();

    // Adjust trust based on availability
    if (trust.availability >= 99) {
      this.adjustTrustScore(peerId, this.policy.highAvailabilityDelta);
    } else if (trust.availability >= 90) {
      this.adjustTrustScore(peerId, this.policy.goodAvailabilityDelta);
    } else if (availability >= 50) {
      this.adjustTrustScore(peerId, 0);
    } else {
      this.adjustTrustScore(peerId, this.policy.lowAvailabilityDelta);
    }
  }

  recordObservation(input: {
    eventId: string;
    peerId: PeerId;
    type: TrustObservationType;
    responseTime?: number;
    availability?: number;
  }): boolean {
    if (this.processedEvents.has(input.eventId)) {
      return false;
    }
    this.processedEvents.add(input.eventId);

    switch (input.type) {
      case 'success':
        this.recordSuccessfulResponse(input.peerId, input.responseTime ?? 0);
        break;
      case 'failure':
        this.recordFailedResponse(input.peerId);
        break;
      case 'connected':
        this.recordPeerConnection(input.peerId);
        break;
      case 'disconnected':
        this.recordPeerDisconnection(input.peerId);
        break;
      case 'availability':
        this.updateAvailability(input.peerId, input.availability ?? 0);
        break;
    }
    return true;
  }

  /**
   * Adjust trust score
   */
  private adjustTrustScore(peerId: PeerId, delta: number): void {
    const trust = this.getTrustScore(peerId);
    trust.score = Math.max(
      this.policy.minScore,
      Math.min(this.policy.maxScore, trust.score + delta),
    );
    trust.lastUpdated = this.clock.now();
  }

  /**
   * Calculate average latency
   */
  private calculateAverageLatency(times: number[]): number {
    if (times.length === 0) {
      return 0;
    }
    const sum = times.reduce((acc, time) => acc + time, 0);
    return sum / times.length;
  }

  /**
   * Calculate success rate
   */
  calculateSuccessRate(peerId: PeerId): number {
    const trust = this.getTrustScore(peerId);
    const total = trust.successfulResponses + trust.failedResponses;
    if (total === 0) {
      return 0;
    }
    return (trust.successfulResponses / total) * 100;
  }

  /**
   * Get trust level
   */
  getTrustLevel(peerId: PeerId): 'excellent' | 'good' | 'acceptable' | 'poor' | 'bad' {
    const trust = this.getTrustScore(peerId);
    const score = trust.score;

    if (score >= this.thresholds.excellent) {
      return 'excellent';
    } else if (score >= this.thresholds.good) {
      return 'good';
    } else if (score >= this.thresholds.acceptable) {
      return 'acceptable';
    } else if (score >= this.thresholds.poor) {
      return 'poor';
    } else {
      return 'bad';
    }
  }

  /**
   * Get all trust scores
   */
  getAllTrustScores(): TrustScore[] {
    return Array.from(this.trustScores.values());
  }

  /**
   * Get top trusted peers
   */
  getTopTrustedPeers(limit: number = 10): TrustScore[] {
    return [...this.trustScores.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Get average trust score
   */
  getAverageTrustScore(): number {
    const scores = Array.from(this.trustScores.values());
    if (scores.length === 0) {
      return 0;
    }
    return scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
  }

  /**
   * Get average availability
   */
  getAverageAvailability(): number {
    const scores = Array.from(this.trustScores.values());
    if (scores.length === 0) {
      return 0;
    }
    return scores.reduce((sum, s) => sum + s.availability, 0) / scores.length;
  }

  /**
   * Get average latency
   */
  getAverageLatency(): number {
    const scores = Array.from(this.trustScores.values());
    if (scores.length === 0) {
      return 0;
    }
    return scores.reduce((sum, s) => sum + s.latency, 0) / scores.length;
  }

  /**
   * Update thresholds
   */
  updateThresholds(thresholds: Partial<TrustThresholds>): void {
    this.thresholds = {
      ...this.thresholds,
      ...thresholds,
    };
  }

  /**
   * Get current thresholds
   */
  getThresholds(): TrustThresholds {
    return { ...this.thresholds };
  }

  /**
   * Reset trust score for a peer
   */
  resetTrustScore(peerId: PeerId): void {
    this.trustScores.set(peerId, {
      peerId,
      score: 500,
      availability: 0,
      latency: 0,
      successfulResponses: 0,
      failedResponses: 0,
      lastUpdated: this.clock.now(),
    });
    this.responseTimes.delete(peerId);
  }

  /**
   * Remove trust score for a peer
   */
  removeTrustScore(peerId: PeerId): void {
    this.trustScores.delete(peerId);
    this.responseTimes.delete(peerId);
  }

  /**
   * Clear all trust scores
   */
  clearAll(): void {
    this.trustScores.clear();
    this.responseTimes.clear();
  }

  /**
   * Get trust score count
   */
  getCount(): number {
    return this.trustScores.size;
  }

  /**
   * Export trust scores to JSON
   */
  exportToJSON(): string {
    return JSON.stringify(Array.from(this.trustScores.values()), null, 2);
  }

  /**
   * Import trust scores from JSON
   */
  importFromJSON(json: string): void {
    try {
      const scores = JSON.parse(json) as TrustScore[];
      for (const score of scores) {
        if (this.isTrustScore(score)) {
          this.trustScores.set(score.peerId, score);
        }
      }
    } catch (error) {
      this.logger.error('import_failed', error);
    }
  }

  /**
   * Calculate trust trend (positive/negative/neutral)
   */
  calculateTrustTrend(peerId: PeerId, previousScore: number): 'positive' | 'negative' | 'neutral' {
    const current = this.getTrustScore(peerId);
    const threshold = 50; // 50 point threshold
    const diff = current.score - previousScore;

    if (diff > threshold) {
      return 'positive';
    } else if (diff < -threshold) {
      return 'negative';
    }
    return 'neutral';
  }

  /**
   * Get peer ranking (percentile)
   */
  getPeerRanking(peerId: PeerId): number {
    const scores = Array.from(this.trustScores.values()).sort((a, b) => b.score - a.score);
    const index = scores.findIndex((s) => s.peerId === peerId);
    if (index === -1) {
      return 0;
    }
    return ((scores.length - index) / scores.length) * 100;
  }

  /**
   * Decay trust scores over time (reduce scores of inactive peers)
   */
  decayTrustScores(decayRate: number = 0.01, inactiveThreshold: number = 86400000): void {
    const now = this.clock.now();
    for (const trust of this.trustScores.values()) {
      const inactiveTime = now - trust.lastUpdated;
      if (inactiveTime > inactiveThreshold) {
        const decay = Math.floor(trust.score * decayRate);
        trust.score = Math.max(0, trust.score - decay);
        trust.lastUpdated = now;
      }
    }
  }

  private isTrustScore(value: unknown): value is TrustScore {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const score = value as Record<string, unknown>;
    return (
      typeof score.peerId === 'string' &&
      typeof score.score === 'number' &&
      Number.isFinite(score.score) &&
      typeof score.availability === 'number' &&
      Number.isFinite(score.availability) &&
      typeof score.latency === 'number' &&
      Number.isFinite(score.latency) &&
      typeof score.successfulResponses === 'number' &&
      typeof score.failedResponses === 'number' &&
      typeof score.lastUpdated === 'number'
    );
  }
}

function validateTrustPolicy(policy: TrustPolicy): void {
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid trust policy value for ${key}`);
    }
  }
  if (policy.minScore >= policy.maxScore) {
    throw new Error('Trust policy minScore must be lower than maxScore');
  }
}
