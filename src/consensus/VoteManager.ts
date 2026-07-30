import type { PeerId } from '../network/NetworkTypes';
import type { ContributionVote, VoteType } from './ConsensusTypes';
import { sha256Hex } from '../utils/hash';
import { canonicalize } from '../economy/Wallet/TransactionModel';
import type { Clock } from '../time/Clock';
import { systemClock } from '../time/Clock';
import { createLogger } from '../observability/Logger';

export type VoteCastResult =
  | { accepted: true; vote: ContributionVote; duplicate: false }
  | { accepted: true; vote: ContributionVote; duplicate: true }
  | { accepted: false; reason: 'conflict' | 'invalid'; existing?: ContributionVote };

/**
 * Vote Manager handles vote collection and counting
 */
export class VoteManager {
  private votes: Map<string, ContributionVote> = new Map();
  private votesByContribution: Map<string, Set<string>> = new Map();
  private votesByVoter: Map<PeerId, Set<string>> = new Map();
  private readonly logger = createLogger('consensus.votes');

  constructor(private readonly clock: Clock = systemClock) {}

  /**
   * Cast a vote
   */
  castVote(
    contributionId: string,
    voter: PeerId,
    vote: VoteType,
    reason?: string,
    signature?: string,
  ): ContributionVote {
    const result = this.tryCastVote(contributionId, voter, vote, reason, signature);
    if (result.accepted) {
      return result.vote;
    }
    if (result.existing) {
      return result.existing;
    }
    throw new Error(`Vote rejected: ${result.reason}`);
  }

  tryCastVote(
    contributionId: string,
    voter: PeerId,
    vote: VoteType,
    reason?: string,
    signature?: string,
  ): VoteCastResult {
    if (vote !== 'approve' && vote !== 'reject' && vote !== 'abstain') {
      return { accepted: false, reason: 'invalid' };
    }
    const voteId = this.createVoteId(contributionId, voter);
    const existing = this.votes.get(voteId);
    if (existing) {
      if (existing.vote === vote && existing.reason === reason) {
        return { accepted: true, vote: existing, duplicate: true };
      }
      return { accepted: false, reason: 'conflict', existing };
    }

    const contributionVote: ContributionVote = {
      contributionId,
      voter,
      vote,
      reason,
      timestamp: this.clock.now(),
      signature: signature || '',
    };

    this.votes.set(voteId, contributionVote);

    // Track by contribution
    if (!this.votesByContribution.has(contributionId)) {
      this.votesByContribution.set(contributionId, new Set());
    }
    this.votesByContribution.get(contributionId)!.add(voteId);

    // Track by voter
    if (!this.votesByVoter.has(voter)) {
      this.votesByVoter.set(voter, new Set());
    }
    this.votesByVoter.get(voter)!.add(voteId);

    return { accepted: true, vote: contributionVote, duplicate: false };
  }

  /**
   * Get vote by ID
   */
  getVote(voteId: string): ContributionVote | null {
    return this.votes.get(voteId) || null;
  }

  /**
   * Get votes for a contribution
   */
  getVotesForContribution(contributionId: string): ContributionVote[] {
    const voteIds = this.votesByContribution.get(contributionId);
    if (!voteIds) {
      return [];
    }

    const votes: ContributionVote[] = [];
    for (const voteId of voteIds) {
      const vote = this.votes.get(voteId);
      if (vote) {
        votes.push(vote);
      }
    }

    return votes;
  }

  /**
   * Get votes by a voter
   */
  getVotesByVoter(voter: PeerId): ContributionVote[] {
    const voteIds = this.votesByVoter.get(voter);
    if (!voteIds) {
      return [];
    }

    const votes: ContributionVote[] = [];
    for (const voteId of voteIds) {
      const vote = this.votes.get(voteId);
      if (vote) {
        votes.push(vote);
      }
    }

    return votes;
  }

  /**
   * Get votes by type for a contribution
   */
  getVotesByType(contributionId: string, voteType: VoteType): ContributionVote[] {
    return this.getVotesForContribution(contributionId).filter((v) => v.vote === voteType);
  }

  /**
   * Count votes for a contribution
   */
  countVotes(contributionId: string): {
    total: number;
    approve: number;
    reject: number;
    abstain: number;
  } {
    const votes = this.getVotesForContribution(contributionId);

    return {
      total: votes.length,
      approve: votes.filter((v) => v.vote === 'approve').length,
      reject: votes.filter((v) => v.vote === 'reject').length,
      abstain: votes.filter((v) => v.vote === 'abstain').length,
    };
  }

  /**
   * Calculate approval percentage
   */
  calculateApprovalPercentage(contributionId: string): number {
    const counts = this.countVotes(contributionId);
    if (counts.total === 0) {
      return 0;
    }

    return (counts.approve / counts.total) * 100;
  }

  /**
   * Check if voter has already voted on contribution
   */
  hasVoted(contributionId: string, voter: PeerId): boolean {
    const votes = this.getVotesForContribution(contributionId);
    return votes.some((v) => v.voter === voter);
  }

  /**
   * Check if vote is valid
   */
  validateVote(vote: ContributionVote): boolean {
    // Check if timestamp is recent (within 5 minutes)
    const timestampAge = this.clock.now() - vote.timestamp;
    if (timestampAge > 5 * 60 * 1000) {
      return false;
    }

    // Check if voter has not already voted
    if (this.hasVoted(vote.contributionId, vote.voter)) {
      return false;
    }

    // Check if vote type is valid
    if (vote.vote !== 'approve' && vote.vote !== 'reject' && vote.vote !== 'abstain') {
      return false;
    }

    return true;
  }

  /**
   * Remove vote
   */
  removeVote(voteId: string): boolean {
    const vote = this.votes.get(voteId);
    if (!vote) {
      return false;
    }

    // Remove from contribution tracking
    const contributionVotes = this.votesByContribution.get(vote.contributionId);
    if (contributionVotes) {
      contributionVotes.delete(voteId);
    }

    // Remove from voter tracking
    const voterVotes = this.votesByVoter.get(vote.voter);
    if (voterVotes) {
      voterVotes.delete(voteId);
    }

    return this.votes.delete(voteId);
  }

  /**
   * Remove all votes for a contribution
   */
  removeVotesForContribution(contributionId: string): number {
    const voteIds = this.votesByContribution.get(contributionId);
    if (!voteIds) {
      return 0;
    }

    let count = 0;
    for (const voteId of voteIds) {
      if (this.removeVote(voteId)) {
        count++;
      }
    }

    this.votesByContribution.delete(contributionId);
    return count;
  }

  /**
   * Remove all votes by a voter
   */
  removeVotesByVoter(voter: PeerId): number {
    const voteIds = this.votesByVoter.get(voter);
    if (!voteIds) {
      return 0;
    }

    let count = 0;
    for (const voteId of voteIds) {
      if (this.removeVote(voteId)) {
        count++;
      }
    }

    this.votesByVoter.delete(voter);
    return count;
  }

  /**
   * Get all votes
   */
  getAllVotes(): ContributionVote[] {
    return Array.from(this.votes.values());
  }

  restoreVotes(votes: readonly ContributionVote[]): void {
    this.clearAll();
    for (const vote of votes) {
      if (!isStoredVote(vote)) {
        this.logger.warn('stored_vote_rejected', { reason: 'invalid' });
        continue;
      }
      const voteId = this.createVoteId(vote.contributionId, vote.voter);
      const existing = this.votes.get(voteId);
      if (existing && (existing.vote !== vote.vote || existing.reason !== vote.reason)) {
        this.logger.warn('stored_vote_rejected', { reason: 'conflict', voteId });
        continue;
      }
      this.votes.set(voteId, vote);

      if (!this.votesByContribution.has(vote.contributionId)) {
        this.votesByContribution.set(vote.contributionId, new Set());
      }
      this.votesByContribution.get(vote.contributionId)!.add(voteId);

      if (!this.votesByVoter.has(vote.voter)) {
        this.votesByVoter.set(vote.voter, new Set());
      }
      this.votesByVoter.get(vote.voter)!.add(voteId);
    }
  }

  /**
   * Clear all votes
   */
  clearAll(): void {
    this.votes.clear();
    this.votesByContribution.clear();
    this.votesByVoter.clear();
  }

  /**
   * Get total vote count
   */
  getCount(): number {
    return this.votes.size;
  }

  /**
   * Get vote count for a contribution
   */
  getContributionVoteCount(contributionId: string): number {
    return this.votesByContribution.get(contributionId)?.size || 0;
  }

  /**
   * Get vote count for a voter
   */
  getVoterVoteCount(voter: PeerId): number {
    return this.votesByVoter.get(voter)?.size || 0;
  }

  /**
   * Get vote statistics
   */
  getStatistics(): {
    totalVotes: number;
    totalContributions: number;
    totalVoters: number;
    averageApprovalRate: number;
    byType: Map<VoteType, number>;
  } {
    const votes = Array.from(this.votes.values());
    const totalVotes = votes.length;
    const totalContributions = this.votesByContribution.size;
    const totalVoters = this.votesByVoter.size;

    const byType = new Map<VoteType, number>();
    for (const vote of votes) {
      const count = byType.get(vote.vote) || 0;
      byType.set(vote.vote, count + 1);
    }

    let totalApprovalRate = 0;
    let contributionsWithVotes = 0;

    for (const contributionId of this.votesByContribution.keys()) {
      const approvalRate = this.calculateApprovalPercentage(contributionId);
      if (approvalRate > 0) {
        totalApprovalRate += approvalRate;
        contributionsWithVotes++;
      }
    }

    const averageApprovalRate =
      contributionsWithVotes > 0 ? totalApprovalRate / contributionsWithVotes : 0;

    return {
      totalVotes,
      totalContributions,
      totalVoters,
      averageApprovalRate,
      byType,
    };
  }

  /**
   * Export votes to JSON
   */
  exportToJSON(): string {
    return JSON.stringify(Array.from(this.votes.values()), null, 2);
  }

  /**
   * Import votes from JSON
   */
  importFromJSON(json: string): void {
    try {
      const voteArray = JSON.parse(json) as ContributionVote[];
      for (const vote of voteArray) {
        if (this.validateVote(vote)) {
          const voteId = this.createVoteId(vote.contributionId, vote.voter);
          this.votes.set(voteId, vote);

          if (!this.votesByContribution.has(vote.contributionId)) {
            this.votesByContribution.set(vote.contributionId, new Set());
          }
          this.votesByContribution.get(vote.contributionId)!.add(voteId);

          if (!this.votesByVoter.has(vote.voter)) {
            this.votesByVoter.set(vote.voter, new Set());
          }
          this.votesByVoter.get(vote.voter)!.add(voteId);
        }
      }
    } catch (error) {
      this.logger.error('import_failed', error);
    }
  }

  private createVoteId(contributionId: string, voter: PeerId): string {
    return `vote_${sha256Hex(canonicalize({ contributionId, voter })).slice(0, 32)}`;
  }
}

function isStoredVote(value: unknown): value is ContributionVote {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const vote = value as Record<string, unknown>;
  return (
    typeof vote.contributionId === 'string' &&
    typeof vote.voter === 'string' &&
    (vote.vote === 'approve' || vote.vote === 'reject' || vote.vote === 'abstain') &&
    typeof vote.timestamp === 'number' &&
    typeof vote.signature === 'string'
  );
}
