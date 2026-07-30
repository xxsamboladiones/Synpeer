import type { PeerId } from '../network/NetworkTypes';
import type {
  ConsensusRound as ConsensusRoundType,
  ConsensusStatus,
  ContributionType,
} from './ConsensusTypes';
import { ConsensusEvents } from './ConsensusEvents';
import { EvidenceManager } from './EvidenceManager';
import { WitnessManager } from './WitnessManager';
import { VoteManager } from './VoteManager';
import { QuorumManager } from './QuorumManager';
import { PeerVerification } from './PeerVerification';
import { createLogger } from '../observability/Logger';
import type { Clock } from '../time/Clock';
import { systemClock } from '../time/Clock';

/**
 * Consensus Round manages the lifecycle of a consensus round
 */
export class ConsensusRound {
  private round: ConsensusRoundType;
  private events: ConsensusEvents;
  private evidenceManager: EvidenceManager;
  private witnessManager: WitnessManager;
  private voteManager: VoteManager;
  private quorumManager: QuorumManager;
  private peerVerification: PeerVerification;
  private readonly logger = createLogger('consensus.round');

  constructor(
    roundId: string,
    contributionId: string,
    contributor: PeerId,
    type: ContributionType,
    value: number,
    events: ConsensusEvents,
    evidenceManager: EvidenceManager,
    witnessManager: WitnessManager,
    voteManager: VoteManager,
    quorumManager: QuorumManager,
    peerVerification: PeerVerification,
    private readonly clock: Clock = systemClock,
    private readonly onStateChanged: () => void = () => {},
    initialRound?: ConsensusRoundType,
  ) {
    this.round = initialRound
      ? { ...initialRound, witnesses: [...initialRound.witnesses], votes: [...initialRound.votes] }
      : {
          roundId,
          contributionId,
          status: 'pending',
          startTime: this.clock.now(),
          witnesses: [],
          votes: [],
          quorumRequired: quorumManager.getMinPeers(),
          quorumReached: false,
          approvalPercentage: 0,
        };

    this.events = events;
    this.evidenceManager = evidenceManager;
    this.witnessManager = witnessManager;
    this.voteManager = voteManager;
    this.quorumManager = quorumManager;
    this.peerVerification = peerVerification;
  }

  /**
   * Start the consensus round
   */
  start(): void {
    this.round.status = 'voting';
    this.events.emitRoundStarted(
      this.round.roundId,
      this.round.contributionId,
      this.round.contributionId,
      this.round.witnesses,
      this.round.quorumRequired,
    );

    this.expireIfTimedOut();
    this.notifyChanged();
  }

  /**
   * Select witnesses
   */
  selectWitnesses(excludePeers: PeerId[] = []): PeerId[] {
    const witnesses = this.witnessManager.selectWitnesses(this.round.contributionId, excludePeers);
    this.round.witnesses = witnesses;

    for (const witness of witnesses) {
      this.events.emitWitnessSelected(
        this.round.roundId,
        witness,
        witness,
        this.witnessManager.getWitnessInfo(witness)?.trustScore || 0,
      );
    }

    this.notifyChanged();
    return witnesses;
  }

  /**
   * Submit evidence
   */
  submitEvidence(evidenceHash: string): boolean {
    const evidence = this.evidenceManager.getEvidence(evidenceHash);
    if (!evidence) {
      return false;
    }

    const submitted = this.evidenceManager.submitEvidence(evidence);
    if (submitted) {
      this.events.emitEvidenceSubmitted(
        this.round.roundId,
        evidence.contributor,
        evidenceHash,
        evidence.contributor,
        evidence.type,
      );
      this.notifyChanged();
    }

    return submitted;
  }

  /**
   * Cast vote
   */
  castVote(voter: PeerId, vote: 'approve' | 'reject' | 'abstain', reason?: string): boolean {
    // Verify voter
    const verification = this.peerVerification.verifyPeer(voter);
    if (!verification.verified) {
      this.logger.warn('voter_not_verified', { peerId: voter, reason: verification.reason });
      return false;
    }

    // Check if voter has already voted
    if (this.voteManager.hasVoted(this.round.contributionId, voter)) {
      this.logger.warn('duplicate_vote_rejected', { peerId: voter });
      return false;
    }

    const result = this.voteManager.tryCastVote(this.round.contributionId, voter, vote, reason);
    if (!result.accepted || result.duplicate) {
      return false;
    }

    this.round.votes.push(result.vote);
    this.events.emitVoteCast(this.round.roundId, voter, vote, voter, reason);

    // Check quorum
    this.checkQuorum();
    this.notifyChanged();

    return true;
  }

  recordVerifiedVote(
    voter: PeerId,
    vote: 'approve' | 'reject' | 'abstain',
    reason?: string,
    signature?: string,
  ): boolean {
    const result = this.voteManager.tryCastVote(
      this.round.contributionId,
      voter,
      vote,
      reason,
      signature,
    );
    if (!result.accepted) {
      this.logger.warn('verified_vote_rejected', { peerId: voter, reason: result.reason });
      return false;
    }
    if (result.duplicate) {
      return true;
    }

    this.round.votes.push(result.vote);
    this.events.emitVoteCast(this.round.roundId, voter, vote, voter, reason);
    this.checkQuorum();
    this.notifyChanged();
    return true;
  }

  recordExternalResult(input: {
    result: 'approved' | 'rejected';
    approvalPercentage: number;
    decidedAt: number;
  }): boolean {
    if (this.round.status === 'reached') {
      return (
        this.round.result === input.result &&
        this.round.approvalPercentage === input.approvalPercentage
      );
    }
    if (this.round.status === 'failed' || this.round.status === 'expired') {
      return false;
    }

    this.round.status = 'reached';
    this.round.result = input.result;
    this.round.quorumReached = true;
    this.round.approvalPercentage = input.approvalPercentage;
    this.round.endTime = input.decidedAt;
    this.events.emitRoundReached(
      this.round.roundId,
      this.round.contributionId,
      input.result,
      input.approvalPercentage,
    );
    this.notifyChanged();
    return true;
  }

  /**
   * Check if quorum is reached
   */
  private checkQuorum(): void {
    const counts = this.voteManager.countVotes(this.round.contributionId);
    const quorumResult = this.quorumManager.calculateQuorum(
      counts.total,
      counts.approve,
      counts.reject,
      counts.abstain,
    );

    this.round.approvalPercentage = quorumResult.approvalPercentage;

    if (quorumResult.reached && !this.round.quorumReached) {
      this.round.quorumReached = true;
      this.events.emitQuorumReached(
        this.round.roundId,
        this.round.contributionId,
        quorumResult.approvalPercentage,
        quorumResult.requiredAgreement * 100,
      );

      // Record quorum result
      this.quorumManager.recordQuorum(this.round.contributionId, quorumResult);

      // Determine final result
      if (quorumResult.approvalPercentage > quorumResult.rejectPercentage) {
        this.complete('approved');
      } else {
        this.complete('rejected');
      }
    } else {
      this.events.emitRoundVoting(
        this.round.roundId,
        this.round.contributionId,
        counts.total,
        this.round.quorumRequired,
      );
      this.notifyChanged();
    }
  }

  /**
   * Handle timeout
   */
  expireIfTimedOut(now = this.clock.now()): boolean {
    if (
      this.round.status === 'voting' &&
      now - this.round.startTime >= this.quorumManager.getTimeout()
    ) {
      this.round.status = 'expired';
      this.round.endTime = now;
      this.events.emitRoundExpired(
        this.round.roundId,
        this.round.contributionId,
        this.quorumManager.getTimeout(),
      );
      this.notifyChanged();
      return true;
    }
    return false;
  }

  /**
   * Complete the round
   */
  private complete(result: 'approved' | 'rejected'): void {
    this.round.status = 'reached';
    this.round.result = result;
    this.round.endTime = this.clock.now();

    this.events.emitRoundReached(
      this.round.roundId,
      this.round.contributionId,
      result,
      this.round.approvalPercentage,
    );
    this.notifyChanged();
  }

  /**
   * Fail the round
   */
  fail(reason: string): void {
    this.round.status = 'failed';
    this.round.endTime = this.clock.now();

    this.events.emitRoundFailed(this.round.roundId, this.round.contributionId, reason);
    this.notifyChanged();
  }

  /**
   * Get round info
   */
  getRound(): ConsensusRoundType {
    return { ...this.round };
  }

  /**
   * Get round status
   */
  getStatus(): ConsensusStatus {
    return this.round.status;
  }

  /**
   * Get round duration
   */
  getDuration(): number {
    const endTime = this.round.endTime || this.clock.now();
    return endTime - this.round.startTime;
  }

  /**
   * Check if round is complete
   */
  isComplete(): boolean {
    return (
      this.round.status === 'reached' ||
      this.round.status === 'failed' ||
      this.round.status === 'expired'
    );
  }

  /**
   * Check if round is successful
   */
  isSuccessful(): boolean {
    return this.round.status === 'reached' && this.round.result === 'approved';
  }

  /**
   * Cancel the round
   */
  cancel(): void {
    this.round.status = 'failed';
    this.round.endTime = this.clock.now();
    this.notifyChanged();
  }

  /**
   * Get vote counts
   */
  getVoteCounts(): {
    total: number;
    approve: number;
    reject: number;
    abstain: number;
  } {
    return this.voteManager.countVotes(this.round.contributionId);
  }

  /**
   * Get approval percentage
   */
  getApprovalPercentage(): number {
    return this.round.approvalPercentage;
  }

  /**
   * Get witnesses
   */
  getWitnesses(): PeerId[] {
    return this.round.witnesses;
  }

  /**
   * Get votes
   */
  getVotes() {
    return this.voteManager.getVotesForContribution(this.round.contributionId);
  }

  private notifyChanged(): void {
    this.onStateChanged();
  }
}
