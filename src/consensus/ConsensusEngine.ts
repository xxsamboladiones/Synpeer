import type { PeerId } from '../network/NetworkTypes';
import type { ContributionType, ConsensusStatistics } from './ConsensusTypes';
import { ConsensusEvents } from './ConsensusEvents';
import { EvidenceManager } from './EvidenceManager';
import { WitnessManager } from './WitnessManager';
import { VoteManager } from './VoteManager';
import { QuorumManager } from './QuorumManager';
import { PeerVerification } from './PeerVerification';
import { ConsensusRound } from './ConsensusRound';
import type { Clock } from '../time/Clock';
import { systemClock } from '../time/Clock';
import { createLogger } from '../observability/Logger';
import { canonicalize } from '../economy/Wallet/TransactionModel';
import { sha256Hex } from '../utils/hash';
import {
  ConsensusRepository,
  consensusPersistenceError,
  type ConsensusSnapshot,
} from './ConsensusRepository';

/**
 * Consensus Engine is the central coordinator for distributed consensus
 */
export class ConsensusEngine {
  private events: ConsensusEvents;
  private evidenceManager: EvidenceManager;
  private witnessManager: WitnessManager;
  private voteManager: VoteManager;
  private quorumManager: QuorumManager;
  private peerVerification: PeerVerification;
  private rounds: Map<string, ConsensusRound> = new Map();
  private startTime: number;
  private readonly logger = createLogger('consensus.engine');
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly repository?: ConsensusRepository,
  ) {
    this.events = new ConsensusEvents();
    this.evidenceManager = new EvidenceManager();
    this.witnessManager = new WitnessManager();
    this.voteManager = new VoteManager(clock);
    this.quorumManager = new QuorumManager();
    this.peerVerification = new PeerVerification();
    this.startTime = this.clock.now();
  }

  async initialize(): Promise<void> {
    if (!this.repository) {
      return;
    }
    await this.repository.initialize();
    const snapshot = await this.repository.loadSnapshot();
    if (snapshot) {
      this.restoreSnapshot(snapshot);
    }
  }

  /**
   * Start a consensus round for a contribution
   */
  startContributionRound(
    contributionId: string,
    contributor: PeerId,
    type: ContributionType,
    value: number,
    options: { roundId?: string; startedAt?: number } = {},
  ): ConsensusRound {
    const startedAt = options.startedAt ?? this.clock.now();
    const roundId =
      options.roundId ??
      `round_${sha256Hex(
        canonicalize({ contributionId, contributor, type, value, startedAt }),
      ).slice(0, 32)}`;

    const existing = this.rounds.get(roundId);
    if (existing) {
      return existing;
    }

    const round = new ConsensusRound(
      roundId,
      contributionId,
      contributor,
      type,
      value,
      this.events,
      this.evidenceManager,
      this.witnessManager,
      this.voteManager,
      this.quorumManager,
      this.peerVerification,
      this.clock,
      () => this.enqueuePersistSnapshot(),
    );

    this.rounds.set(roundId, round);
    this.enqueuePersistSnapshot();
    return round;
  }

  recordVerifiedVote(input: {
    roundId: string;
    contributionId: string;
    voter: PeerId;
    vote: 'approve' | 'reject' | 'abstain';
    reason?: string;
    signature?: string;
  }): boolean {
    const round =
      this.rounds.get(input.roundId) ?? this.getRoundByContributionId(input.contributionId);
    if (!round) {
      this.logger.warn('remote_vote_rejected', {
        reason: 'round-not-found',
        roundId: input.roundId,
      });
      return false;
    }
    const applied = round.recordVerifiedVote(
      input.voter,
      input.vote,
      input.reason,
      input.signature,
    );
    if (applied) {
      this.enqueuePersistSnapshot();
    }
    return applied;
  }

  recordExternalResult(input: {
    roundId: string;
    contributionId: string;
    result: 'approved' | 'rejected' | 'pending';
    approvalPercentage: number;
    decidedAt: number;
  }): boolean {
    if (input.result === 'pending') {
      return false;
    }
    const round =
      this.rounds.get(input.roundId) ?? this.getRoundByContributionId(input.contributionId);
    if (!round) {
      this.logger.warn('remote_result_rejected', {
        reason: 'round-not-found',
        roundId: input.roundId,
      });
      return false;
    }
    const applied = round.recordExternalResult({
      result: input.result,
      approvalPercentage: input.approvalPercentage,
      decidedAt: input.decidedAt,
    });
    if (applied) {
      this.enqueuePersistSnapshot();
    }
    return applied;
  }

  /**
   * Get a round by ID
   */
  getRound(roundId: string): ConsensusRound | null {
    return this.rounds.get(roundId) || null;
  }

  /**
   * Get round by contribution ID
   */
  getRoundByContributionId(contributionId: string): ConsensusRound | null {
    for (const round of this.rounds.values()) {
      if (round.getRound().contributionId === contributionId) {
        return round;
      }
    }
    return null;
  }

  /**
   * Get all rounds
   */
  getAllRounds(): ConsensusRound[] {
    return Array.from(this.rounds.values());
  }

  /**
   * Get active rounds
   */
  getActiveRounds(): ConsensusRound[] {
    return Array.from(this.rounds.values()).filter((r) => !r.isComplete());
  }

  /**
   * Get completed rounds
   */
  getCompletedRounds(): ConsensusRound[] {
    return Array.from(this.rounds.values()).filter((r) => r.isComplete());
  }

  /**
   * Get successful rounds
   */
  getSuccessfulRounds(): ConsensusRound[] {
    return Array.from(this.rounds.values()).filter((r) => r.isSuccessful());
  }

  /**
   * Remove round
   */
  removeRound(roundId: string): boolean {
    const round = this.rounds.get(roundId);
    if (round) {
      round.cancel();
      const deleted = this.rounds.delete(roundId);
      this.enqueuePersistSnapshot();
      return deleted;
    }
    return false;
  }

  /**
   * Clear all rounds
   */
  clearAllRounds(): void {
    for (const round of this.rounds.values()) {
      round.cancel();
    }
    this.rounds.clear();
    this.enqueuePersistSnapshot();
  }

  /**
   * Get events manager
   */
  getEvents(): ConsensusEvents {
    return this.events;
  }

  /**
   * Get evidence manager
   */
  getEvidenceManager(): EvidenceManager {
    return this.evidenceManager;
  }

  /**
   * Get witness manager
   */
  getWitnessManager(): WitnessManager {
    return this.witnessManager;
  }

  /**
   * Get vote manager
   */
  getVoteManager(): VoteManager {
    return this.voteManager;
  }

  /**
   * Get quorum manager
   */
  getQuorumManager(): QuorumManager {
    return this.quorumManager;
  }

  /**
   * Get peer verification
   */
  getPeerVerification(): PeerVerification {
    return this.peerVerification;
  }

  /**
   * Get statistics
   */
  getStatistics(): ConsensusStatistics {
    const rounds = this.getAllRounds();
    const successfulRounds = this.getSuccessfulRounds();
    const failedRounds = rounds.filter((r) => r.isComplete() && !r.isSuccessful());

    const totalRoundTime = rounds.reduce((sum, r) => sum + r.getDuration(), 0);
    const averageRoundTime = rounds.length > 0 ? totalRoundTime / rounds.length : 0;

    const totalContributions = this.evidenceManager.getCount();
    const totalProofs = successfulRounds.length;
    const totalBundles = 0; // Will be implemented in Task 11

    const approvalRates = successfulRounds.map((r) => r.getApprovalPercentage());
    const averageApprovalRate =
      approvalRates.length > 0
        ? approvalRates.reduce((sum, rate) => sum + rate, 0) / approvalRates.length
        : 0;

    const fraudReports = this.peerVerification.getStatistics().fraudReports;
    const sybilDetections = this.peerVerification.getStatistics().sybilDetections;

    return {
      totalRounds: rounds.length,
      successfulRounds: successfulRounds.length,
      failedRounds: failedRounds.length,
      averageRoundTime,
      totalContributions,
      totalProofs,
      totalBundles,
      averageApprovalRate,
      fraudReports,
      sybilDetections,
      lastUpdated: this.clock.now(),
    };
  }

  /**
   * Get engine uptime
   */
  getUptime(): number {
    return this.clock.now() - this.startTime;
  }

  /**
   * Export data to JSON
   */
  exportToJSON(): string {
    return JSON.stringify(
      {
        statistics: this.getStatistics(),
        evidence: this.evidenceManager.exportToJSON(),
        votes: this.voteManager.exportToJSON(),
        quorumHistory: this.quorumManager.exportToJSON(),
        fingerprints: this.peerVerification.exportFingerprintsToJSON(),
        fraudReports: this.peerVerification.exportFraudReportsToJSON(),
      },
      null,
      2,
    );
  }

  /**
   * Import data from JSON
   */
  importFromJSON(json: string): void {
    try {
      const data = JSON.parse(json) as {
        evidence?: string;
        votes?: string;
        quorumHistory?: string;
        fingerprints?: string;
        fraudReports?: string;
      };

      if (data.evidence) {
        this.evidenceManager.importFromJSON(data.evidence);
      }

      if (data.votes) {
        this.voteManager.importFromJSON(data.votes);
      }

      if (data.quorumHistory) {
        this.quorumManager.importFromJSON(data.quorumHistory);
      }

      if (data.fingerprints) {
        this.peerVerification.importFingerprintsFromJSON(data.fingerprints);
      }

      if (data.fraudReports) {
        this.peerVerification.importFraudReportsFromJSON(data.fraudReports);
      }
      this.enqueuePersistSnapshot();
    } catch (error) {
      this.logger.error('import_failed', error);
    }
  }

  /**
   * Reset engine
   */
  reset(): void {
    this.clearAllRounds();
    this.evidenceManager.clearAll();
    this.witnessManager.clearAll();
    this.voteManager.clearAll();
    this.quorumManager.clearHistory();
    this.peerVerification.clearAllFingerprints();
    this.peerVerification.clearAllFraudReports();
    this.peerVerification.clearAllSuspicious();
    this.peerVerification.clearAllBans();
    this.startTime = this.clock.now();
    this.enqueuePersistSnapshot();
  }

  async persistSnapshot(): Promise<void> {
    if (!this.repository) {
      return;
    }
    try {
      await this.repository.saveSnapshot(this.createSnapshot());
    } catch (error) {
      throw consensusPersistenceError(error);
    }
  }

  async flushPersistence(): Promise<void> {
    await this.persistQueue;
  }

  createSnapshot(): ConsensusSnapshot {
    return {
      version: 1,
      rounds: this.getAllRounds().map((round) => round.getRound()),
      votes: this.voteManager.getAllVotes(),
      quorumHistory: this.quorumManager.getSnapshotEntries(),
      capturedAt: this.clock.now(),
    };
  }

  private restoreSnapshot(snapshot: ConsensusSnapshot): void {
    this.voteManager.restoreVotes(snapshot.votes);
    this.quorumManager.restoreSnapshotEntries(snapshot.quorumHistory);
    this.rounds.clear();
    for (const roundState of snapshot.rounds) {
      const round = new ConsensusRound(
        roundState.roundId,
        roundState.contributionId,
        roundState.contributionId,
        'VALIDATION',
        0,
        this.events,
        this.evidenceManager,
        this.witnessManager,
        this.voteManager,
        this.quorumManager,
        this.peerVerification,
        this.clock,
        () => this.enqueuePersistSnapshot(),
        roundState,
      );
      this.rounds.set(roundState.roundId, round);
    }
  }

  private enqueuePersistSnapshot(): void {
    if (!this.repository) {
      return;
    }
    this.persistQueue = this.persistQueue
      .then(() => this.persistSnapshot())
      .catch((error: unknown) => {
        this.logger.error('persist_failed', error);
      });
  }
}
