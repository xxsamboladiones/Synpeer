import type { QuorumRequirements } from './ConsensusTypes';
import { defaultQuorumRequirements } from './ConsensusTypes';
import type { Clock } from '../time/Clock';
import { systemClock } from '../time/Clock';
import { createLogger } from '../observability/Logger';

/**
 * Quorum result
 */
export interface QuorumResult {
  reached: boolean;
  requiredPeers: number;
  actualPeers: number;
  requiredAgreement: number;
  actualAgreement: number;
  approvalPercentage: number;
  rejectPercentage: number;
  abstainPercentage: number;
  timestamp: number;
}

/**
 * Quorum Manager handles quorum calculation and validation
 */
export class QuorumManager {
  private requirements: QuorumRequirements;
  private quorumHistory: Map<string, QuorumResult> = new Map();
  private readonly logger = createLogger('consensus.quorum');

  constructor(
    requirements?: Partial<QuorumRequirements>,
    private readonly clock: Clock = systemClock,
  ) {
    this.requirements = {
      ...defaultQuorumRequirements,
      ...requirements,
    };
  }

  /**
   * Calculate quorum for a contribution
   */
  calculateQuorum(
    totalPeers: number,
    approveCount: number,
    rejectCount: number,
    abstainCount: number,
  ): QuorumResult {
    const totalVotes = approveCount + rejectCount + abstainCount;

    const requiredPeers = this.requirements.minPeers;
    const actualPeers = totalVotes;

    const requiredAgreement = this.requirements.requiredAgreement;
    const approvalPercentage = totalVotes > 0 ? (approveCount / totalVotes) * 100 : 0;
    const actualAgreement = approvalPercentage / 100;

    const rejectPercentage = totalVotes > 0 ? (rejectCount / totalVotes) * 100 : 0;
    const abstainPercentage = totalVotes > 0 ? (abstainCount / totalVotes) * 100 : 0;

    const reached =
      actualPeers >= requiredPeers &&
      actualAgreement >= requiredAgreement &&
      approvalPercentage > rejectPercentage;

    const result: QuorumResult = {
      reached,
      requiredPeers,
      actualPeers,
      requiredAgreement,
      actualAgreement,
      approvalPercentage,
      rejectPercentage,
      abstainPercentage,
      timestamp: this.clock.now(),
    };

    return result;
  }

  /**
   * Validate quorum result
   */
  validateQuorum(result: QuorumResult): boolean {
    // Check if timestamp is recent (within timeout)
    const timestampAge = this.clock.now() - result.timestamp;
    if (timestampAge > this.requirements.timeout) {
      return false;
    }

    // Check if quorum was reached
    if (!result.reached) {
      return false;
    }

    // Check if actual peers meet minimum
    if (result.actualPeers < result.requiredPeers) {
      return false;
    }

    // Check if actual agreement meets required
    if (result.actualAgreement < result.requiredAgreement) {
      return false;
    }

    return true;
  }

  /**
   * Check if quorum is reached
   */
  isQuorumReached(
    totalPeers: number,
    approveCount: number,
    rejectCount: number,
    abstainCount: number,
  ): boolean {
    const result = this.calculateQuorum(totalPeers, approveCount, rejectCount, abstainCount);
    return result.reached;
  }

  /**
   * Get minimum peers required
   */
  getMinPeers(): number {
    return this.requirements.minPeers;
  }

  /**
   * Get required agreement percentage
   */
  getRequiredAgreementPercentage(): number {
    return this.requirements.requiredAgreement * 100;
  }

  /**
   * Get minimum trust score
   */
  getMinTrustScore(): number {
    return this.requirements.minTrustScore;
  }

  /**
   * Get timeout
   */
  getTimeout(): number {
    return this.requirements.timeout;
  }

  /**
   * Update requirements
   */
  updateRequirements(requirements: Partial<QuorumRequirements>): void {
    this.requirements = {
      ...this.requirements,
      ...requirements,
    };
  }

  /**
   * Get current requirements
   */
  getRequirements(): QuorumRequirements {
    return { ...this.requirements };
  }

  /**
   * Record quorum result
   */
  recordQuorum(contributionId: string, result: QuorumResult): void {
    this.quorumHistory.set(contributionId, result);
  }

  /**
   * Get quorum result for contribution
   */
  getQuorumResult(contributionId: string): QuorumResult | null {
    return this.quorumHistory.get(contributionId) || null;
  }

  /**
   * Get all quorum results
   */
  getAllQuorumResults(): QuorumResult[] {
    return Array.from(this.quorumHistory.values());
  }

  getSnapshotEntries(): Array<[string, QuorumResult]> {
    return Array.from(this.quorumHistory.entries());
  }

  restoreSnapshotEntries(entries: readonly [string, QuorumResult][]): void {
    this.quorumHistory.clear();
    for (const [contributionId, result] of entries) {
      if (isStoredQuorumResult(result)) {
        this.quorumHistory.set(contributionId, result);
      } else {
        this.logger.warn('stored_quorum_rejected', { contributionId });
      }
    }
  }

  /**
   * Get successful quorum results
   */
  getSuccessfulQuorumResults(): QuorumResult[] {
    return Array.from(this.quorumHistory.values()).filter((r) => r.reached);
  }

  /**
   * Get failed quorum results
   */
  getFailedQuorumResults(): QuorumResult[] {
    return Array.from(this.quorumHistory.values()).filter((r) => !r.reached);
  }

  /**
   * Calculate quorum statistics
   */
  getStatistics(): {
    total: number;
    successful: number;
    failed: number;
    successRate: number;
    averageApprovalRate: number;
    averagePeerCount: number;
  } {
    const results = Array.from(this.quorumHistory.values());
    const total = results.length;
    const successful = results.filter((r) => r.reached).length;
    const failed = total - successful;

    const successRate = total > 0 ? (successful / total) * 100 : 0;

    const averageApprovalRate =
      total > 0 ? results.reduce((sum, r) => sum + r.approvalPercentage, 0) / total : 0;

    const averagePeerCount =
      total > 0 ? results.reduce((sum, r) => sum + r.actualPeers, 0) / total : 0;

    return {
      total,
      successful,
      failed,
      successRate,
      averageApprovalRate,
      averagePeerCount,
    };
  }

  /**
   * Clear quorum history
   */
  clearHistory(): void {
    this.quorumHistory.clear();
  }

  /**
   * Clear quorum result for contribution
   */
  clearQuorumResult(contributionId: string): boolean {
    return this.quorumHistory.delete(contributionId);
  }

  /**
   * Get quorum history count
   */
  getHistoryCount(): number {
    return this.quorumHistory.size;
  }

  /**
   * Export quorum results to JSON
   */
  exportToJSON(): string {
    return JSON.stringify(Array.from(this.quorumHistory.entries()), null, 2);
  }

  /**
   * Import quorum results from JSON
   */
  importFromJSON(json: string): void {
    try {
      const entries = JSON.parse(json) as [string, QuorumResult][];
      for (const [contributionId, result] of entries) {
        if (this.validateQuorum(result)) {
          this.quorumHistory.set(contributionId, result);
        }
      }
    } catch (error) {
      this.logger.error('import_failed', error);
    }
  }

  /**
   * Calculate dynamic quorum requirements based on network size
   */
  calculateDynamicRequirements(networkSize: number): QuorumRequirements {
    // Scale requirements based on network size
    const scaledMinPeers = Math.min(
      Math.max(Math.floor(networkSize * 0.01), this.requirements.minPeers),
      100,
    );

    const scaledRequiredAgreement = Math.max(
      this.requirements.requiredAgreement,
      networkSize > 1000 ? 0.6 : 0.66,
    );

    return {
      ...this.requirements,
      minPeers: scaledMinPeers,
      requiredAgreement: scaledRequiredAgreement,
    };
  }

  /**
   * Estimate time to quorum based on current voting rate
   */
  estimateTimeToQuorum(
    currentVotes: number,
    requiredVotes: number,
    votingRate: number, // votes per second
  ): number {
    if (currentVotes >= requiredVotes) {
      return 0;
    }

    if (votingRate <= 0) {
      return Infinity;
    }

    const remainingVotes = requiredVotes - currentVotes;
    const secondsNeeded = remainingVotes / votingRate;

    return secondsNeeded * 1000; // Convert to milliseconds
  }

  /**
   * Check if quorum is likely to be reached before timeout
   */
  isQuorumLikely(
    currentVotes: number,
    requiredVotes: number,
    votingRate: number,
    elapsedTime: number,
  ): boolean {
    const estimatedTime = this.estimateTimeToQuorum(currentVotes, requiredVotes, votingRate);
    const remainingTime = this.requirements.timeout - elapsedTime;

    return estimatedTime <= remainingTime;
  }
}

function isStoredQuorumResult(value: unknown): value is QuorumResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const result = value as Record<string, unknown>;
  return (
    typeof result.reached === 'boolean' &&
    typeof result.requiredPeers === 'number' &&
    typeof result.actualPeers === 'number' &&
    typeof result.requiredAgreement === 'number' &&
    typeof result.actualAgreement === 'number' &&
    typeof result.approvalPercentage === 'number' &&
    typeof result.rejectPercentage === 'number' &&
    typeof result.abstainPercentage === 'number' &&
    typeof result.timestamp === 'number'
  );
}
