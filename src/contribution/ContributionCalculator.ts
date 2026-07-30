import type {
  ContributionMetrics,
  ContributionScore,
  ContributionWeights,
} from './ContributionTypes';
import { defaultContributionWeights } from './ContributionTypes';

/**
 * ContributionCalculator calculates contribution scores
 */
export class ContributionCalculator {
  private weights: ContributionWeights;

  constructor(weights: ContributionWeights = defaultContributionWeights) {
    this.weights = weights;
  }

  /**
   * Calculate contribution score from metrics
   */
  calculateScore(metrics: ContributionMetrics): ContributionScore {
    const storageScore = this.calculateStorageScore(metrics.storageShared);
    const bandwidthScore = this.calculateBandwidthScore(metrics.bandwidthShared);
    const replicationScore = this.calculateReplicationScore(
      metrics.chunksServed,
      metrics.postsReplicated,
      metrics.mediaReplicated,
    );
    const uptimeScore = this.calculateUptimeScore(metrics.uptime);
    const reliabilityScore = this.calculateReliabilityScore(
      metrics.successfulUploads,
      metrics.successfulDownloads,
      metrics.requestsReceived,
    );

    const totalScore =
      storageScore * this.weights.storageWeight +
      bandwidthScore * this.weights.bandwidthWeight +
      replicationScore * this.weights.replicationWeight +
      uptimeScore * this.weights.uptimeWeight +
      reliabilityScore * this.weights.reliabilityWeight;

    return {
      peerId: metrics.peerId,
      totalScore,
      storageScore,
      bandwidthScore,
      replicationScore,
      uptimeScore,
      reliabilityScore,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Calculate storage score (0-100)
   */
  private calculateStorageScore(storageShared: number): number {
    // Normalize: 1GB = 100 points
    const gigabytes = storageShared / (1024 * 1024 * 1024);
    return Math.min(100, gigabytes * 100);
  }

  /**
   * Calculate bandwidth score (0-100)
   */
  private calculateBandwidthScore(bandwidthShared: number): number {
    // Normalize: 10GB = 100 points
    const gigabytes = bandwidthShared / (1024 * 1024 * 1024);
    return Math.min(100, (gigabytes / 10) * 100);
  }

  /**
   * Calculate replication score (0-100)
   */
  private calculateReplicationScore(
    chunksServed: number,
    postsReplicated: number,
    mediaReplicated: number,
  ): number {
    // Weighted formula
    const chunkScore = Math.min(50, chunksServed * 0.1);
    const postScore = Math.min(30, postsReplicated * 2);
    const mediaScore = Math.min(20, mediaReplicated * 5);
    return chunkScore + postScore + mediaScore;
  }

  /**
   * Calculate uptime score (0-100)
   */
  private calculateUptimeScore(uptime: number): number {
    // Normalize: 24 hours = 100 points
    const hours = uptime / 3600;
    return Math.min(100, (hours / 24) * 100);
  }

  /**
   * Calculate reliability score (0-100)
   */
  private calculateReliabilityScore(
    successfulUploads: number,
    successfulDownloads: number,
    requestsReceived: number,
  ): number {
    if (requestsReceived === 0) {
      return 0;
    }

    const successful = successfulUploads + successfulDownloads;
    const successRate = (successful / requestsReceived) * 100;
    return successRate;
  }

  /**
   * Calculate score for multiple peers
   */
  calculateScores(metricsArray: ContributionMetrics[]): ContributionScore[] {
    return metricsArray.map((metrics) => this.calculateScore(metrics));
  }

  /**
   * Get top contributors by score
   */
  getTopContributors(scores: ContributionScore[], limit: number = 10): ContributionScore[] {
    return [...scores].sort((a, b) => b.totalScore - a.totalScore).slice(0, limit);
  }

  /**
   * Get score percentile
   */
  getScorePercentile(score: ContributionScore, allScores: ContributionScore[]): number {
    const sortedScores = [...allScores].sort((a, b) => a.totalScore - b.totalScore);
    const index = sortedScores.findIndex((s) => s.peerId === score.peerId);
    if (index === -1) {
      return 0;
    }
    return (index / sortedScores.length) * 100;
  }

  /**
   * Update weights
   */
  updateWeights(weights: Partial<ContributionWeights>): void {
    this.weights = {
      ...this.weights,
      ...weights,
    };
  }

  /**
   * Get current weights
   */
  getWeights(): ContributionWeights {
    return { ...this.weights };
  }

  /**
   * Calculate score trend (positive/negative/neutral)
   */
  calculateScoreTrend(
    currentScore: number,
    previousScore: number,
  ): 'positive' | 'negative' | 'neutral' {
    const threshold = 5; // 5% threshold
    const percentChange = ((currentScore - previousScore) / previousScore) * 100;

    if (percentChange > threshold) {
      return 'positive';
    } else if (percentChange < -threshold) {
      return 'negative';
    }
    return 'neutral';
  }

  /**
   * Calculate score growth rate
   */
  calculateScoreGrowthRate(currentScore: number, previousScore: number, timeDiff: number): number {
    if (timeDiff === 0) {
      return 0;
    }
    return (currentScore - previousScore) / timeDiff;
  }

  /**
   * Normalize score to 0-100 range
   */
  normalizeScore(score: number, minScore: number, maxScore: number): number {
    if (maxScore === minScore) {
      return 0;
    }
    return ((score - minScore) / (maxScore - minScore)) * 100;
  }
}
