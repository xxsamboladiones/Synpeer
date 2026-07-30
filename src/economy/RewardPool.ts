import type { RewardCategory, RewardPoolConfig } from './RewardTypes';
import { defaultRewardPoolWeights } from './RewardTypes';

/**
 * Reward Pool Manager manages reward categories and weights
 */
export class RewardPool {
  private pools: Map<RewardCategory, RewardPoolConfig>;
  private dailyAllocations: Map<RewardCategory, number>;
  private peerAllocations: Map<string, Map<RewardCategory, number>>;

  constructor(configs?: Partial<Record<RewardCategory, RewardPoolConfig>>) {
    this.pools = new Map();
    this.dailyAllocations = new Map();
    this.peerAllocations = new Map();

    // Initialize default pools
    const defaultConfigs: Record<RewardCategory, RewardPoolConfig> = {
      STORAGE: {
        category: 'STORAGE',
        weight: defaultRewardPoolWeights.STORAGE,
        dailyLimit: 300000,
        perPeerLimit: 300,
        enabled: true,
      },
      BANDWIDTH: {
        category: 'BANDWIDTH',
        weight: defaultRewardPoolWeights.BANDWIDTH,
        dailyLimit: 250000,
        perPeerLimit: 250,
        enabled: true,
      },
      STREAMING: {
        category: 'STREAMING',
        weight: defaultRewardPoolWeights.STREAMING,
        dailyLimit: 150000,
        perPeerLimit: 150,
        enabled: true,
      },
      REPLICATION: {
        category: 'REPLICATION',
        weight: defaultRewardPoolWeights.REPLICATION,
        dailyLimit: 150000,
        perPeerLimit: 150,
        enabled: true,
      },
      AVAILABILITY: {
        category: 'AVAILABILITY',
        weight: defaultRewardPoolWeights.AVAILABILITY,
        dailyLimit: 100000,
        perPeerLimit: 100,
        enabled: true,
      },
      COMMUNITY: {
        category: 'COMMUNITY',
        weight: defaultRewardPoolWeights.COMMUNITY,
        dailyLimit: 50000,
        perPeerLimit: 50,
        enabled: true,
      },
    };

    // Apply custom configs
    if (configs) {
      for (const [category, config] of Object.entries(configs)) {
        defaultConfigs[category as RewardCategory] = {
          ...defaultConfigs[category as RewardCategory],
          ...config,
        };
      }
    }

    // Initialize pools
    for (const [category, config] of Object.entries(defaultConfigs)) {
      this.pools.set(category as RewardCategory, config);
      this.dailyAllocations.set(category as RewardCategory, 0);
    }
  }

  /**
   * Get pool configuration
   */
  getPoolConfig(category: RewardCategory): RewardPoolConfig | null {
    return this.pools.get(category) || null;
  }

  /**
   * Get all pool configurations
   */
  getAllPoolConfigs(): RewardPoolConfig[] {
    return Array.from(this.pools.values());
  }

  /**
   * Update pool configuration
   */
  updatePoolConfig(category: RewardCategory, config: Partial<RewardPoolConfig>): void {
    const existing = this.pools.get(category);
    if (existing) {
      this.pools.set(category, {
        ...existing,
        ...config,
      });
    }
  }

  /**
   * Enable pool
   */
  enablePool(category: RewardCategory): void {
    const config = this.pools.get(category);
    if (config) {
      config.enabled = true;
    }
  }

  /**
   * Disable pool
   */
  disablePool(category: RewardCategory): void {
    const config = this.pools.get(category);
    if (config) {
      config.enabled = false;
    }
  }

  /**
   * Check if pool is enabled
   */
  isPoolEnabled(category: RewardCategory): boolean {
    const config = this.pools.get(category);
    return config?.enabled ?? false;
  }

  /**
   * Get daily allocation for category
   */
  getDailyAllocation(category: RewardCategory): number {
    return this.dailyAllocations.get(category) || 0;
  }

  /**
   * Get all daily allocations
   */
  getAllDailyAllocations(): Map<RewardCategory, number> {
    return new Map(this.dailyAllocations);
  }

  /**
   * Get total daily allocation
   */
  getTotalDailyAllocation(): number {
    return Array.from(this.dailyAllocations.values()).reduce((sum, value) => sum + value, 0);
  }

  /**
   * Get remaining daily allocation for category
   */
  getRemainingDailyAllocation(category: RewardCategory): number {
    const config = this.pools.get(category);
    const allocated = this.dailyAllocations.get(category) || 0;

    if (!config || !config.enabled) {
      return 0;
    }

    return Math.max(0, config.dailyLimit - allocated);
  }

  /**
   * Allocate reward to category
   */
  allocateReward(category: RewardCategory, amount: number, peerId?: string): boolean {
    const config = this.pools.get(category);
    if (!config || !config.enabled) {
      return false;
    }

    // Check daily limit
    const currentAllocation = this.dailyAllocations.get(category) || 0;
    if (currentAllocation + amount > config.dailyLimit) {
      return false;
    }

    // Check peer limit if peer ID provided
    if (peerId) {
      const peerAllocations = this.peerAllocations.get(peerId) || new Map();
      const peerCurrentAllocation = peerAllocations.get(category) || 0;

      if (peerCurrentAllocation + amount > config.perPeerLimit) {
        return false;
      }

      peerAllocations.set(category, peerCurrentAllocation + amount);
      this.peerAllocations.set(peerId, peerAllocations);
    }

    this.dailyAllocations.set(category, currentAllocation + amount);
    return true;
  }

  /**
   * Get peer allocation for category
   */
  getPeerAllocation(peerId: string, category: RewardCategory): number {
    const peerAllocations = this.peerAllocations.get(peerId);
    return peerAllocations?.get(category) || 0;
  }

  /**
   * Get all peer allocations
   */
  getAllPeerAllocations(peerId: string): Map<RewardCategory, number> {
    return this.peerAllocations.get(peerId) || new Map();
  }

  /**
   * Get total peer allocation
   */
  getTotalPeerAllocation(peerId: string): number {
    const peerAllocations = this.peerAllocations.get(peerId);
    if (!peerAllocations) {
      return 0;
    }

    return Array.from(peerAllocations.values()).reduce((sum, value) => sum + value, 0);
  }

  /**
   * Reset daily allocations
   */
  resetDailyAllocations(): void {
    for (const category of this.pools.keys()) {
      this.dailyAllocations.set(category, 0);
    }
  }

  /**
   * Reset peer allocations
   */
  resetPeerAllocations(peerId?: string): void {
    if (peerId) {
      this.peerAllocations.delete(peerId);
    } else {
      this.peerAllocations.clear();
    }
  }

  /**
   * Calculate reward amount based on pool weight
   */
  calculateRewardAmount(totalPool: number, category: RewardCategory): number {
    const config = this.pools.get(category);
    if (!config || !config.enabled) {
      return 0;
    }

    return totalPool * config.weight;
  }

  /**
   * Get pool weights
   */
  getPoolWeights(): Record<RewardCategory, number> {
    const weights: Record<RewardCategory, number> = {} as Record<RewardCategory, number>;

    for (const [category, config] of this.pools.entries()) {
      weights[category] = config.weight;
    }

    return weights;
  }

  /**
   * Normalize pool weights
   */
  normalizeWeights(): void {
    const totalWeight = Array.from(this.pools.values()).reduce(
      (sum, config) => sum + config.weight,
      0,
    );

    if (totalWeight === 0) {
      return;
    }

    for (const config of this.pools.values()) {
      config.weight = config.weight / totalWeight;
    }
  }

  /**
   * Get statistics
   */
  getStatistics(): {
    totalPools: number;
    enabledPools: number;
    totalDailyLimit: number;
    totalDailyAllocated: number;
    totalDailyRemaining: number;
    totalPeerAllocations: number;
    byCategory: Map<RewardCategory, { limit: number; allocated: number; remaining: number }>;
  } {
    const totalPools = this.pools.size;
    const enabledPools = Array.from(this.pools.values()).filter((p) => p.enabled).length;

    const totalDailyLimit = Array.from(this.pools.values()).reduce(
      (sum, p) => sum + p.dailyLimit,
      0,
    );
    const totalDailyAllocated = this.getTotalDailyAllocation();
    const totalDailyRemaining = totalDailyLimit - totalDailyAllocated;

    let totalPeerAllocations = 0;
    for (const peerAllocs of this.peerAllocations.values()) {
      totalPeerAllocations += Array.from(peerAllocs.values()).reduce(
        (sum, value) => sum + value,
        0,
      );
    }

    const byCategory = new Map<
      RewardCategory,
      { limit: number; allocated: number; remaining: number }
    >();

    for (const [cat, config] of this.pools.entries()) {
      const allocated = this.dailyAllocations.get(cat) || 0;
      byCategory.set(cat, {
        limit: config.dailyLimit,
        allocated,
        remaining: config.dailyLimit - allocated,
      });
    }

    return {
      totalPools,
      enabledPools,
      totalDailyLimit,
      totalDailyAllocated,
      totalDailyRemaining,
      totalPeerAllocations,
      byCategory,
    };
  }

  /**
   * Export to JSON
   */
  exportToJSON(): string {
    return JSON.stringify(
      {
        pools: Array.from(this.pools.values()),
        dailyAllocations: Array.from(this.dailyAllocations.entries()),
        peerAllocations: Array.from(this.peerAllocations.entries()).map(([peerId, allocs]) => [
          peerId,
          Array.from(allocs.entries()),
        ]),
      },
      null,
      2,
    );
  }

  /**
   * Import from JSON
   */
  importFromJSON(json: string): void {
    try {
      const data = JSON.parse(json) as {
        pools?: RewardPoolConfig[];
        dailyAllocations?: [RewardCategory, number][];
        peerAllocations?: [string, [RewardCategory, number][]][];
      };

      if (data.pools) {
        for (const config of data.pools) {
          this.pools.set(config.category, config);
        }
      }

      if (data.dailyAllocations) {
        for (const [category, value] of data.dailyAllocations) {
          this.dailyAllocations.set(category, value);
        }
      }

      if (data.peerAllocations) {
        for (const [peerId, allocs] of data.peerAllocations) {
          const peerAllocsMap = new Map(allocs);
          this.peerAllocations.set(peerId, peerAllocsMap);
        }
      }
    } catch (error) {
      console.error('[RewardPool] Failed to import from JSON:', error);
    }
  }
}
