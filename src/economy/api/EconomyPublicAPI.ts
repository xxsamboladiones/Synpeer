import type { PeerId } from '../../network/NetworkTypes';
import type { Wallet, Transaction, RewardCategory, ContributionProof } from '../RewardTypes';
import { WalletService } from '../Wallet/WalletService';
import { RewardCalculator } from '../RewardCalculator';
import { RewardSchedule } from '../RewardSchedule';
import { LedgerEngine } from '../Ledger/LedgerEngine';
import { RewardPool } from '../RewardPool';
import { InflationController } from '../InflationController';
import { AntiAbuseController } from '../AntiAbuseController';

/**
 * Public API for Economy Layer
 */
export class EconomyPublicAPI {
  private walletService: WalletService;
  private rewardCalculator: RewardCalculator;
  private rewardSchedule: RewardSchedule;
  private ledgerEngine: LedgerEngine;
  private rewardPool: RewardPool;
  private inflationController: InflationController;
  private antiAbuseController: AntiAbuseController;

  constructor() {
    this.walletService = new WalletService();
    this.rewardCalculator = new RewardCalculator();
    this.rewardSchedule = new RewardSchedule();
    this.ledgerEngine = new LedgerEngine();
    this.rewardPool = new RewardPool();
    this.inflationController = new InflationController();
    this.antiAbuseController = new AntiAbuseController();
  }

  // ==================== Wallet API ====================

  /**
   * Get wallet balance
   */
  getWalletBalance(peerId: PeerId): number {
    const wallet = this.walletService.getWalletByPeerId(peerId);
    return wallet?.balance ?? 0;
  }

  /**
   * Get wallet address
   */
  getWalletAddress(peerId: PeerId): string | null {
    const wallet = this.walletService.getWalletByPeerId(peerId);
    return wallet?.address ?? null;
  }

  /**
   * Get wallet transactions
   */
  getWalletTransactions(peerId: PeerId, limit?: number): Transaction[] {
    const wallet = this.walletService.getWalletByPeerId(peerId);
    if (!wallet) {
      return [];
    }
    return this.walletService.getTransactions(limit);
  }

  /**
   * Create wallet
   */
  createWallet(peerId: PeerId): Wallet {
    return this.walletService.createWallet(peerId);
  }

  // ==================== Reward API ====================

  /**
   * Calculate reward for contribution
   */
  calculateReward(proof: ContributionProof): number {
    const result = this.rewardCalculator.calculateReward(proof);
    return result.netReward;
  }

  /**
   * Calculate batch rewards
   */
  calculateBatchRewards(proofs: ContributionProof[]): number[] {
    const results = this.rewardCalculator.calculateBatchRewards(proofs);
    return results.map((r) => r.netReward);
  }

  /**
   * Get reward breakdown
   */
  getRewardBreakdown(proof: ContributionProof): Record<RewardCategory, number> {
    const result = this.rewardCalculator.calculateReward(proof);
    return {
      STORAGE: result.breakdown.storage,
      BANDWIDTH: result.breakdown.bandwidth,
      STREAMING: result.breakdown.streaming,
      REPLICATION: result.breakdown.replication,
      AVAILABILITY: result.breakdown.availability,
      COMMUNITY: result.breakdown.community,
    };
  }

  /**
   * Get current reward schedule
   */
  getCurrentRewardSchedule(): {
    year: number;
    dailyEmission: number;
    monthlyEmission: number;
    totalEmission: number;
  } {
    const entry = this.rewardSchedule.getCurrentScheduleEntry();
    return {
      year: this.rewardSchedule.getCurrentYear(),
      dailyEmission: entry?.dailyEmission ?? 0,
      monthlyEmission: entry?.monthlyEmission ?? 0,
      totalEmission: entry?.totalEmission ?? 0,
    };
  }

  /**
   * Get remaining daily emission
   */
  getRemainingDailyEmission(): number {
    return this.rewardSchedule.getRemainingEmission();
  }

  // ==================== Ledger API ====================

  /**
   * Get ledger entry by ID
   */
  getLedgerEntry(id: string): unknown {
    return this.ledgerEngine.getEntry(id);
  }

  /**
   * Get ledger entries for wallet
   */
  getLedgerEntriesForWallet(walletAddress: string, limit?: number): unknown[] {
    return this.ledgerEngine.getEntriesForWallet(walletAddress, limit);
  }

  /**
   * Get total supply
   */
  getTotalSupply(): number {
    return this.ledgerEngine.getTotalSupply();
  }

  /**
   * Get latest snapshot
   */
  getLatestSnapshot(): unknown | null {
    return this.ledgerEngine.getLatestSnapshot();
  }

  /**
   * Verify ledger integrity
   */
  verifyLedgerIntegrity(): boolean {
    return this.ledgerEngine.verifyIntegrity();
  }

  // ==================== Contribution API ====================

  /**
   * Submit contribution for reward
   */
  submitContribution(proof: ContributionProof): boolean {
    // Check if contribution is valid
    if (!this.validateContribution(proof)) {
      return false;
    }

    // Check abuse
    if (this.antiAbuseController.isPeerBanned(proof.contributor)) {
      return false;
    }

    // Calculate reward
    const result = this.rewardCalculator.calculateReward(proof);

    // Check inflation limits
    if (!this.inflationController.canEmit(result.netReward, proof.contributor)) {
      return false;
    }

    // Allocate reward from pool
    if (!this.rewardPool.allocateReward(proof.category, result.netReward, proof.contributor)) {
      return false;
    }

    // Record emission
    this.inflationController.recordEmission(result.netReward, proof.contributor);

    // Add to ledger
    const walletAddress = this.walletService.getWalletByPeerId(proof.contributor)?.address;
    if (walletAddress) {
      this.ledgerEngine.addEntry(
        walletAddress,
        result.netReward,
        'REWARD',
        `Reward for ${proof.category} contribution`,
        proof.category,
        { contributionId: proof.contributionId },
      );
    }

    return true;
  }

  /**
   * Validate contribution
   */
  validateContribution(proof: ContributionProof): boolean {
    // Check required fields
    if (!proof.contributionId || !proof.contributor || !proof.category || !proof.value) {
      return false;
    }

    // Check value is positive
    if (proof.value <= 0) {
      return false;
    }

    // Check quorum reached
    if (!proof.quorumReached) {
      return false;
    }

    // Check approval percentage
    if (proof.approvalPercentage < 66) {
      return false;
    }

    return true;
  }

  /**
   * Get contribution statistics
   */
  getContributionStatistics(): {
    totalContributions: number;
    totalRewards: number;
    byCategory: Record<RewardCategory, number>;
  } {
    const entries = this.ledgerEngine.getAllEntries();
    const rewardEntries = entries.filter((e) => e.type === 'REWARD');

    const totalContributions = rewardEntries.length;
    const totalRewards = rewardEntries.reduce((sum, e) => sum + e.amount, 0);

    const byCategory: Record<RewardCategory, number> = {
      STORAGE: 0,
      BANDWIDTH: 0,
      STREAMING: 0,
      REPLICATION: 0,
      AVAILABILITY: 0,
      COMMUNITY: 0,
    };

    for (const entry of rewardEntries) {
      if (entry.category) {
        byCategory[entry.category] += entry.amount;
      }
    }

    return {
      totalContributions,
      totalRewards,
      byCategory,
    };
  }

  // ==================== Statistics API ====================

  /**
   * Get economy statistics
   */
  getEconomyStatistics(): {
    totalSupply: number;
    totalWallets: number;
    totalTransactions: number;
    dailyEmission: number;
    remainingDailyEmission: number;
    inflationRate: number;
    emissionPercentage: number;
  } {
    return {
      totalSupply: this.ledgerEngine.getTotalSupply(),
      totalWallets: this.ledgerEngine.getWalletCount(),
      totalTransactions: this.ledgerEngine.getEntryCount(),
      dailyEmission: this.rewardSchedule.getDailyEmission(),
      remainingDailyEmission: this.rewardSchedule.getRemainingEmission(),
      inflationRate: this.rewardSchedule.getInflationRate(),
      emissionPercentage: this.rewardSchedule.getEmissionPercentage(),
    };
  }

  /**
   * Get reward pool statistics
   */
  getRewardPoolStatistics(): {
    totalPools: number;
    enabledPools: number;
    totalDailyLimit: number;
    totalDailyAllocated: number;
    byCategory: Record<RewardCategory, { limit: number; allocated: number; remaining: number }>;
  } {
    const stats = this.rewardPool.getStatistics();
    const byCategory: Record<
      RewardCategory,
      { limit: number; allocated: number; remaining: number }
    > = {
      STORAGE: { limit: 0, allocated: 0, remaining: 0 },
      BANDWIDTH: { limit: 0, allocated: 0, remaining: 0 },
      STREAMING: { limit: 0, allocated: 0, remaining: 0 },
      REPLICATION: { limit: 0, allocated: 0, remaining: 0 },
      AVAILABILITY: { limit: 0, allocated: 0, remaining: 0 },
      COMMUNITY: { limit: 0, allocated: 0, remaining: 0 },
    };

    for (const [category, data] of stats.byCategory.entries()) {
      byCategory[category] = data;
    }

    return {
      totalPools: stats.totalPools,
      enabledPools: stats.enabledPools,
      totalDailyLimit: stats.totalDailyLimit,
      totalDailyAllocated: stats.totalDailyAllocated,
      byCategory,
    };
  }

  /**
   * Get inflation statistics
   */
  getInflationStatistics(): {
    currentSupply: number;
    maxSupply: number;
    remainingSupply: number;
    emissionPercentage: number;
    dailyEmitted: number;
    dailyLimit: number;
    annualReduction: number;
    currentYear: number;
  } {
    const stats = this.inflationController.getStatistics();
    return {
      currentSupply: stats.currentSupply,
      maxSupply: stats.maxSupply,
      remainingSupply: stats.remainingSupply,
      emissionPercentage: stats.emissionPercentage,
      dailyEmitted: stats.dailyEmitted,
      dailyLimit: stats.dailyLimit,
      annualReduction: stats.annualReduction,
      currentYear: stats.currentYear,
    };
  }

  /**
   * Get abuse statistics
   */
  getAbuseStatistics(): {
    totalReports: number;
    resolvedReports: number;
    pendingReports: number;
    topOffenders: Array<{ peerId: string; score: number }>;
  } {
    const stats = this.antiAbuseController.getStatistics();
    const topOffenders = Array.from(stats.topOffenders.entries())
      .map(([peerId, score]) => ({ peerId, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    return {
      totalReports: stats.totalReports,
      resolvedReports: stats.resolvedReports,
      pendingReports: stats.pendingReports,
      topOffenders,
    };
  }

  // ==================== Admin API ====================

  /**
   * Reset daily allocations
   */
  resetDailyAllocations(): void {
    this.rewardPool.resetDailyAllocations();
    this.inflationController.resetDailyEmission();
  }

  /**
   * Update reward weights
   */
  updateRewardWeights(weights: Partial<Record<RewardCategory, number>>): void {
    this.rewardCalculator.updateCategoryWeights(weights);
    this.rewardPool.normalizeWeights();
  }

  /**
   * Update inflation config
   */
  updateInflationConfig(config: {
    dailyLimit?: number;
    perPeerLimit?: number;
    annualReduction?: number;
  }): void {
    this.inflationController.updateConfig(config);
  }

  /**
   * Export economy state
   */
  exportState(): string {
    return JSON.stringify(
      {
        ledger: this.ledgerEngine.exportToJSON(),
        rewardPool: this.rewardPool.exportToJSON(),
        inflation: this.inflationController.exportToJSON(),
        abuse: this.antiAbuseController.exportToJSON(),
      },
      null,
      2,
    );
  }

  /**
   * Import economy state
   */
  importState(json: string): boolean {
    try {
      const data = JSON.parse(json) as {
        ledger?: string;
        rewardPool?: string;
        inflation?: string;
        abuse?: string;
      };

      if (data.ledger) {
        this.ledgerEngine.importFromJSON(data.ledger);
      }

      if (data.rewardPool) {
        this.rewardPool.importFromJSON(data.rewardPool);
      }

      if (data.inflation) {
        this.inflationController.importFromJSON(data.inflation);
      }

      if (data.abuse) {
        this.antiAbuseController.importFromJSON(data.abuse);
      }

      return true;
    } catch (error) {
      console.error('[EconomyPublicAPI] Failed to import state:', error);
      return false;
    }
  }
}
