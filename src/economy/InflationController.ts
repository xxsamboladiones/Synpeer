import type { InflationConfig } from './RewardTypes';
import { defaultInflationConfig } from './RewardTypes';

/**
 * Inflation Controller manages inflation rules and limits
 */
export class InflationController {
  private config: InflationConfig;
  private dailyEmitted: number;
  private peerEmitted: Map<string, number>;
  private startTime: number;

  constructor(config?: Partial<InflationConfig>, startTime?: number) {
    this.config = {
      ...defaultInflationConfig,
      ...config,
    };
    this.dailyEmitted = 0;
    this.peerEmitted = new Map();
    this.startTime = startTime || Date.now();
  }

  /**
   * Check if emission is allowed
   */
  canEmit(amount: number, peerId?: string): boolean {
    // Check max supply
    if (this.config.currentSupply + amount > this.config.maxSupply) {
      return false;
    }

    // Check daily limit
    if (this.dailyEmitted + amount > this.config.dailyLimit) {
      return false;
    }

    // Check peer limit if peer ID provided
    if (peerId) {
      const peerCurrent = this.peerEmitted.get(peerId) || 0;
      if (peerCurrent + amount > this.config.perPeerLimit) {
        return false;
      }
    }

    return true;
  }

  /**
   * Record emission
   */
  recordEmission(amount: number, peerId?: string): void {
    this.config.currentSupply += amount;
    this.dailyEmitted += amount;

    if (peerId) {
      const peerCurrent = this.peerEmitted.get(peerId) || 0;
      this.peerEmitted.set(peerId, peerCurrent + amount);
    }
  }

  /**
   * Get remaining supply
   */
  getRemainingSupply(): number {
    return Math.max(0, this.config.maxSupply - this.config.currentSupply);
  }

  /**
   * Get remaining daily emission
   */
  getRemainingDailyEmission(): number {
    return Math.max(0, this.config.dailyLimit - this.dailyEmitted);
  }

  /**
   * Get remaining peer emission
   */
  getRemainingPeerEmission(peerId: string): number {
    const peerCurrent = this.peerEmitted.get(peerId) || 0;
    return Math.max(0, this.config.perPeerLimit - peerCurrent);
  }

  /**
   * Get current supply
   */
  getCurrentSupply(): number {
    return this.config.currentSupply;
  }

  /**
   * Get max supply
   */
  getMaxSupply(): number {
    return this.config.maxSupply;
  }

  /**
   * Get daily limit
   */
  getDailyLimit(): number {
    return this.config.dailyLimit;
  }

  /**
   * Get peer limit
   */
  getPeerLimit(): number {
    return this.config.perPeerLimit;
  }

  /**
   * Get annual reduction rate
   */
  getAnnualReduction(): number {
    return this.config.annualReduction;
  }

  /**
   * Get current year
   */
  getCurrentYear(): number {
    const elapsed = Date.now() - this.startTime;
    const elapsedYears = elapsed / (365 * 24 * 60 * 60 * 1000);
    return Math.floor(elapsedYears) + 1;
  }

  /**
   * Calculate daily limit for current year
   */
  calculateDailyLimitForYear(year: number): number {
    const reduction = Math.pow(1 - this.config.annualReduction, year - 1);
    return this.config.dailyLimit * reduction;
  }

  /**
   * Update daily limit based on year
   */
  updateDailyLimitForCurrentYear(): void {
    const currentYear = this.getCurrentYear();
    const newDailyLimit = this.calculateDailyLimitForYear(currentYear);
    this.config.dailyLimit = newDailyLimit;
  }

  /**
   * Reset daily emission
   */
  resetDailyEmission(): void {
    this.dailyEmitted = 0;
  }

  /**
   * Reset peer emission
   */
  resetPeerEmission(peerId?: string): void {
    if (peerId) {
      this.peerEmitted.delete(peerId);
    } else {
      this.peerEmitted.clear();
    }
  }

  /**
   * Get daily emitted amount
   */
  getDailyEmitted(): number {
    return this.dailyEmitted;
  }

  /**
   * Get peer emitted amount
   */
  getPeerEmitted(peerId: string): number {
    return this.peerEmitted.get(peerId) || 0;
  }

  /**
   * Get all peer emissions
   */
  getAllPeerEmissions(): Map<string, number> {
    return new Map(this.peerEmitted);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<InflationConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
  }

  /**
   * Get configuration
   */
  getConfig(): InflationConfig {
    return { ...this.config };
  }

  /**
   * Check if max supply reached
   */
  isMaxSupplyReached(): boolean {
    return this.config.currentSupply >= this.config.maxSupply;
  }

  /**
   * Check if daily limit reached
   */
  isDailyLimitReached(): boolean {
    return this.dailyEmitted >= this.config.dailyLimit;
  }

  /**
   * Check if peer limit reached
   */
  isPeerLimitReached(peerId: string): boolean {
    const peerCurrent = this.peerEmitted.get(peerId) || 0;
    return peerCurrent >= this.config.perPeerLimit;
  }

  /**
   * Get inflation rate
   */
  getInflationRate(): number {
    const currentYear = this.getCurrentYear();
    return Math.pow(1 - this.config.annualReduction, currentYear - 1);
  }

  /**
   * Get emission percentage
   */
  getEmissionPercentage(): number {
    return this.config.maxSupply > 0
      ? (this.config.currentSupply / this.config.maxSupply) * 100
      : 0;
  }

  /**
   * Get statistics
   */
  getStatistics(): {
    currentSupply: number;
    maxSupply: number;
    remainingSupply: number;
    emissionPercentage: number;
    dailyEmitted: number;
    dailyLimit: number;
    dailyRemaining: number;
    peerLimit: number;
    totalPeers: number;
    annualReduction: number;
    currentYear: number;
    inflationRate: number;
  } {
    return {
      currentSupply: this.config.currentSupply,
      maxSupply: this.config.maxSupply,
      remainingSupply: this.getRemainingSupply(),
      emissionPercentage: this.getEmissionPercentage(),
      dailyEmitted: this.dailyEmitted,
      dailyLimit: this.config.dailyLimit,
      dailyRemaining: this.getRemainingDailyEmission(),
      peerLimit: this.config.perPeerLimit,
      totalPeers: this.peerEmitted.size,
      annualReduction: this.config.annualReduction,
      currentYear: this.getCurrentYear(),
      inflationRate: this.getInflationRate(),
    };
  }

  /**
   * Export to JSON
   */
  exportToJSON(): string {
    return JSON.stringify(
      {
        config: this.config,
        dailyEmitted: this.dailyEmitted,
        peerEmitted: Array.from(this.peerEmitted.entries()),
        startTime: this.startTime,
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
        config?: InflationConfig;
        dailyEmitted?: number;
        peerEmitted?: [string, number][];
        startTime?: number;
      };

      if (data.config) {
        this.config = data.config;
      }

      if (data.dailyEmitted !== undefined) {
        this.dailyEmitted = data.dailyEmitted;
      }

      if (data.peerEmitted) {
        this.peerEmitted = new Map(data.peerEmitted);
      }

      if (data.startTime) {
        this.startTime = data.startTime;
      }
    } catch (error) {
      console.error('[InflationController] Failed to import from JSON:', error);
    }
  }
}
