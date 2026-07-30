import type { RewardScheduleEntry, InflationConfig } from './RewardTypes';
import { defaultRewardSchedule, defaultInflationConfig } from './RewardTypes';

/**
 * Reward Schedule manages emission schedule
 */
export class RewardSchedule {
  private schedule: RewardScheduleEntry[];
  private inflationConfig: InflationConfig;
  private currentYear: number;
  private startTime: number;

  constructor(
    schedule?: RewardScheduleEntry[],
    inflationConfig?: InflationConfig,
    startTime?: number,
  ) {
    this.schedule = schedule || [...defaultRewardSchedule];
    this.inflationConfig = inflationConfig || { ...defaultInflationConfig };
    this.startTime = startTime || Date.now();
    this.currentYear = this.calculateCurrentYear();
  }

  /**
   * Calculate current year based on start time
   */
  private calculateCurrentYear(): number {
    const elapsed = Date.now() - this.startTime;
    const elapsedYears = elapsed / (365 * 24 * 60 * 60 * 1000);
    return Math.floor(elapsedYears) + 1;
  }

  /**
   * Get current year
   */
  getCurrentYear(): number {
    return this.currentYear;
  }

  /**
   * Get schedule entry for current year
   */
  getCurrentScheduleEntry(): RewardScheduleEntry | null {
    return this.getScheduleEntry(this.currentYear);
  }

  /**
   * Get schedule entry for a specific year
   */
  getScheduleEntry(year: number): RewardScheduleEntry | null {
    return this.schedule.find((entry) => entry.year === year) || null;
  }

  /**
   * Get total schedule
   */
  getSchedule(): RewardScheduleEntry[] {
    return [...this.schedule];
  }

  /**
   * Get daily emission for current year
   */
  getDailyEmission(): number {
    const entry = this.getCurrentScheduleEntry();
    return entry?.dailyEmission || 0;
  }

  /**
   * Get monthly emission for current year
   */
  getMonthlyEmission(): number {
    const entry = this.getCurrentScheduleEntry();
    return entry?.monthlyEmission || 0;
  }

  /**
   * Get total emission for current year
   */
  getTotalEmission(): number {
    const entry = this.getCurrentScheduleEntry();
    return entry?.totalEmission || 0;
  }

  /**
   * Get remaining emission for current year
   */
  getRemainingEmission(): number {
    const entry = this.getCurrentScheduleEntry();
    if (!entry) {
      return 0;
    }

    const elapsedInYear = Date.now() - this.getYearStartTime();
    const elapsedDays = elapsedInYear / (24 * 60 * 60 * 1000);
    const emitted = elapsedDays * entry.dailyEmission;

    return Math.max(0, entry.totalEmission - emitted);
  }

  /**
   * Get start time for current year
   */
  private getYearStartTime(): number {
    const yearOffset = (this.currentYear - 1) * 365 * 24 * 60 * 60 * 1000;
    return this.startTime + yearOffset;
  }

  /**
   * Check if emission limit reached for current day
   */
  isDailyLimitReached(emittedToday: number): boolean {
    const dailyLimit = this.getDailyEmission();
    return emittedToday >= dailyLimit;
  }

  /**
   * Check if emission limit reached for current year
   */
  isYearlyLimitReached(emittedThisYear: number): boolean {
    const yearlyLimit = this.getTotalEmission();
    return emittedThisYear >= yearlyLimit;
  }

  /**
   * Check if emission limit reached for current peer
   */
  isPeerLimitReached(emittedByPeer: number): boolean {
    return emittedByPeer >= this.inflationConfig.perPeerLimit;
  }

  /**
   * Update schedule
   */
  updateSchedule(schedule: RewardScheduleEntry[]): void {
    this.schedule = schedule;
  }

  /**
   * Update inflation config
   */
  updateInflationConfig(config: Partial<InflationConfig>): void {
    this.inflationConfig = {
      ...this.inflationConfig,
      ...config,
    };
  }

  /**
   * Get inflation config
   */
  getInflationConfig(): InflationConfig {
    return { ...this.inflationConfig };
  }

  /**
   * Get max supply
   */
  getMaxSupply(): number {
    return this.inflationConfig.maxSupply;
  }

  /**
   * Get current supply
   */
  getCurrentSupply(): number {
    return this.inflationConfig.currentSupply;
  }

  /**
   * Update current supply
   */
  updateCurrentSupply(supply: number): void {
    this.inflationConfig.currentSupply = supply;
  }

  /**
   * Check if max supply reached
   */
  isMaxSupplyReached(): boolean {
    return this.inflationConfig.currentSupply >= this.inflationConfig.maxSupply;
  }

  /**
   * Get inflation rate
   */
  getInflationRate(): number {
    const entry = this.getCurrentScheduleEntry();
    return entry?.reductionRate || 0;
  }

  /**
   * Get total emission across all years
   */
  getTotalEmissionAcrossAllYears(): number {
    return this.schedule.reduce((sum, entry) => sum + entry.totalEmission, 0);
  }

  /**
   * Get percentage of total supply emitted
   */
  getEmissionPercentage(): number {
    const totalEmission = this.getTotalEmissionAcrossAllYears();
    const maxSupply = this.inflationConfig.maxSupply;
    return maxSupply > 0 ? (totalEmission / maxSupply) * 100 : 0;
  }

  /**
   * Export schedule to JSON
   */
  exportToJSON(): string {
    return JSON.stringify(
      {
        schedule: this.schedule,
        inflationConfig: this.inflationConfig,
        currentYear: this.currentYear,
        startTime: this.startTime,
      },
      null,
      2,
    );
  }

  /**
   * Import schedule from JSON
   */
  importFromJSON(json: string): void {
    try {
      const data = JSON.parse(json) as {
        schedule?: RewardScheduleEntry[];
        inflationConfig?: InflationConfig;
        currentYear?: number;
        startTime?: number;
      };

      if (data.schedule) {
        this.schedule = data.schedule;
      }

      if (data.inflationConfig) {
        this.inflationConfig = data.inflationConfig;
      }

      if (data.currentYear) {
        this.currentYear = data.currentYear;
      }

      if (data.startTime) {
        this.startTime = data.startTime;
      }
    } catch (error) {
      console.error('[RewardSchedule] Failed to import from JSON:', error);
    }
  }
}
