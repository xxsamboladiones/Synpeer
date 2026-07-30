import type { RewardCategory, ContributionProof } from './RewardTypes';

/**
 * Reward calculation result
 */
export interface RewardCalculationResult {
  baseReward: number;
  bonus: number;
  penalty: number;
  netReward: number;
  breakdown: {
    storage: number;
    bandwidth: number;
    streaming: number;
    replication: number;
    availability: number;
    community: number;
  };
}

/**
 * Reward Calculator calculates rewards based on contribution proofs
 */
export class RewardCalculator {
  private categoryWeights: Record<RewardCategory, number>;
  private baseRewardRate: number; // tokens per unit of contribution

  constructor(categoryWeights?: Partial<Record<RewardCategory, number>>, baseRewardRate?: number) {
    this.categoryWeights = {
      STORAGE: 0.3,
      BANDWIDTH: 0.25,
      STREAMING: 0.15,
      REPLICATION: 0.15,
      AVAILABILITY: 0.1,
      COMMUNITY: 0.05,
      ...categoryWeights,
    };
    this.baseRewardRate = baseRewardRate ?? 1.0;
  }

  /**
   * Calculate reward for a contribution proof
   */
  calculateReward(proof: ContributionProof): RewardCalculationResult {
    const baseReward = this.calculateBaseReward(proof);
    const bonus = this.calculateBonus(proof);
    const penalty = this.calculatePenalty(proof);
    const netReward = baseReward + bonus - penalty;

    const breakdown = this.calculateBreakdown(proof, baseReward);

    return {
      baseReward,
      bonus,
      penalty,
      netReward,
      breakdown,
    };
  }

  /**
   * Calculate base reward
   */
  private calculateBaseReward(proof: ContributionProof): number {
    const categoryWeight = this.categoryWeights[proof.category as RewardCategory] || 0.1;
    return proof.value * this.baseRewardRate * categoryWeight;
  }

  /**
   * Calculate bonus
   */
  private calculateBonus(proof: ContributionProof): number {
    let bonus = 0;

    // Bonus for high approval rate
    if (proof.approvalPercentage >= 90) {
      bonus += proof.value * 0.1; // 10% bonus
    } else if (proof.approvalPercentage >= 80) {
      bonus += proof.value * 0.05; // 5% bonus
    }

    // Bonus for early contribution
    const age = Date.now() - proof.timestamp;
    if (age < 24 * 60 * 60 * 1000) {
      // Less than 24 hours
      bonus += proof.value * 0.05; // 5% bonus
    }

    // Bonus for high trust score
    if (proof.trustScore >= 800) {
      bonus += proof.value * 0.1; // 10% bonus
    } else if (proof.trustScore >= 700) {
      bonus += proof.value * 0.05; // 5% bonus
    }

    return bonus;
  }

  /**
   * Calculate penalty
   */
  private calculatePenalty(proof: ContributionProof): number {
    let penalty = 0;

    // Penalty for low approval rate
    if (proof.approvalPercentage < 66) {
      penalty += proof.value * 0.2; // 20% penalty
    } else if (proof.approvalPercentage < 70) {
      penalty += proof.value * 0.1; // 10% penalty
    }

    // Penalty for low trust score
    if (proof.trustScore < 500) {
      penalty += proof.value * 0.15; // 15% penalty
    } else if (proof.trustScore < 600) {
      penalty += proof.value * 0.05; // 5% penalty
    }

    // Penalty for old contribution
    const age = Date.now() - proof.timestamp;
    if (age > 7 * 24 * 60 * 60 * 1000) {
      // More than 7 days
      penalty += proof.value * 0.1; // 10% penalty
    }

    return penalty;
  }

  /**
   * Calculate breakdown by category
   */
  private calculateBreakdown(
    proof: ContributionProof,
    baseReward: number,
  ): RewardCalculationResult['breakdown'] {
    return {
      storage: proof.category === 'STORAGE' ? baseReward : 0,
      bandwidth: proof.category === 'BANDWIDTH' ? baseReward : 0,
      streaming: proof.category === 'STREAMING' ? baseReward : 0,
      replication: proof.category === 'REPLICATION' ? baseReward : 0,
      availability: proof.category === 'AVAILABILITY' ? baseReward : 0,
      community: proof.category === 'COMMUNITY' ? baseReward : 0,
    };
  }

  /**
   * Calculate reward for multiple proofs
   */
  calculateBatchRewards(proofs: ContributionProof[]): RewardCalculationResult[] {
    return proofs.map((proof) => this.calculateReward(proof));
  }

  /**
   * Calculate total reward for multiple proofs
   */
  calculateTotalReward(proofs: ContributionProof[]): RewardCalculationResult {
    const results = this.calculateBatchRewards(proofs);

    const totalBaseReward = results.reduce((sum, r) => sum + r.baseReward, 0);
    const totalBonus = results.reduce((sum, r) => sum + r.bonus, 0);
    const totalPenalty = results.reduce((sum, r) => sum + r.penalty, 0);
    const totalNetReward = totalBaseReward + totalBonus - totalPenalty;

    const totalBreakdown: RewardCalculationResult['breakdown'] = {
      storage: results.reduce((sum, r) => sum + r.breakdown.storage, 0),
      bandwidth: results.reduce((sum, r) => sum + r.breakdown.bandwidth, 0),
      streaming: results.reduce((sum, r) => sum + r.breakdown.streaming, 0),
      replication: results.reduce((sum, r) => sum + r.breakdown.replication, 0),
      availability: results.reduce((sum, r) => sum + r.breakdown.availability, 0),
      community: results.reduce((sum, r) => sum + r.breakdown.community, 0),
    };

    return {
      baseReward: totalBaseReward,
      bonus: totalBonus,
      penalty: totalPenalty,
      netReward: totalNetReward,
      breakdown: totalBreakdown,
    };
  }

  /**
   * Update category weights
   */
  updateCategoryWeights(weights: Partial<Record<RewardCategory, number>>): void {
    this.categoryWeights = {
      ...this.categoryWeights,
      ...weights,
    };
  }

  /**
   * Update base reward rate
   */
  updateBaseRewardRate(rate: number): void {
    this.baseRewardRate = rate;
  }

  /**
   * Get category weights
   */
  getCategoryWeights(): Record<RewardCategory, number> {
    return { ...this.categoryWeights };
  }

  /**
   * Get base reward rate
   */
  getBaseRewardRate(): number {
    return this.baseRewardRate;
  }
}
