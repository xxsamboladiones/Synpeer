import type { PeerId } from '../network/NetworkTypes';
import type { VoteType } from './ConsensusTypes';

/**
 * Consensus event types
 */
export type ConsensusEventType =
  | 'ROUND_STARTED'
  | 'ROUND_VOTING'
  | 'ROUND_REACHED'
  | 'ROUND_FAILED'
  | 'ROUND_EXPIRED'
  | 'VOTE_CAST'
  | 'EVIDENCE_SUBMITTED'
  | 'WITNESS_SELECTED'
  | 'QUORUM_REACHED'
  | 'FRAUD_REPORTED'
  | 'PROOF_GENERATED'
  | 'BUNDLE_CREATED';

/**
 * Base consensus event
 */
export interface ConsensusEvent {
  id: string;
  type: ConsensusEventType;
  roundId: string;
  peerId: PeerId;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * Round started event
 */
export interface RoundStartedEvent extends ConsensusEvent {
  type: 'ROUND_STARTED';
  contributionId: string;
  witnesses: PeerId[];
  quorumRequired: number;
}

/**
 * Round voting event
 */
export interface RoundVotingEvent extends ConsensusEvent {
  type: 'ROUND_VOTING';
  votesReceived: number;
  votesRequired: number;
}

/**
 * Round reached event
 */
export interface RoundReachedEvent extends ConsensusEvent {
  type: 'ROUND_REACHED';
  result: 'approved' | 'rejected';
  approvalPercentage: number;
}

/**
 * Round failed event
 */
export interface RoundFailedEvent extends ConsensusEvent {
  type: 'ROUND_FAILED';
  reason: string;
}

/**
 * Round expired event
 */
export interface RoundExpiredEvent extends ConsensusEvent {
  type: 'ROUND_EXPIRED';
  timeout: number;
}

/**
 * Vote cast event
 */
export interface VoteCastEvent extends ConsensusEvent {
  type: 'VOTE_CAST';
  vote: VoteType;
  voter: PeerId;
  reason?: string;
}

/**
 * Evidence submitted event
 */
export interface EvidenceSubmittedEvent extends ConsensusEvent {
  type: 'EVIDENCE_SUBMITTED';
  evidenceId: string;
  contributor: PeerId;
  contributionType: string;
}

/**
 * Witness selected event
 */
export interface WitnessSelectedEvent extends ConsensusEvent {
  type: 'WITNESS_SELECTED';
  witness: PeerId;
  trustScore: number;
}

/**
 * Quorum reached event
 */
export interface QuorumReachedEvent extends ConsensusEvent {
  type: 'QUORUM_REACHED';
  quorumPercentage: number;
  requiredPercentage: number;
}

/**
 * Fraud reported event
 */
export interface FraudReportedEvent extends ConsensusEvent {
  type: 'FRAUD_REPORTED';
  accused: PeerId;
  fraudType: string;
  evidence: string[];
}

/**
 * Proof generated event
 */
export interface ProofGeneratedEvent extends ConsensusEvent {
  type: 'PROOF_GENERATED';
  proofId: string;
  contributionId: string;
  value: number;
}

/**
 * Bundle created event
 */
export interface BundleCreatedEvent extends ConsensusEvent {
  type: 'BUNDLE_CREATED';
  bundleId: string;
  contributionCount: number;
  totalValue: number;
}

/**
 * ConsensusEvents manages consensus event emission
 */
export class ConsensusEvents {
  private events: ConsensusEvent[] = new Array<ConsensusEvent>();
  private listeners: Map<ConsensusEventType, Set<(event: ConsensusEvent) => void>> = new Map();
  private allListeners: Set<(event: ConsensusEvent) => void> = new Set();
  private eventCounter: number = 0;

  /**
   * Emit a consensus event
   */
  emit(
    type: ConsensusEventType,
    roundId: string,
    peerId: PeerId,
    metadata?: Record<string, unknown>,
  ): ConsensusEvent {
    this.eventCounter++;
    const event: ConsensusEvent = {
      id: `consensus_event_${Date.now()}_${this.eventCounter}`,
      type,
      roundId,
      peerId,
      timestamp: Date.now(),
      metadata,
    };

    this.events.push(event);

    // Notify type-specific listeners
    const typeListeners = this.listeners.get(type);
    if (typeListeners) {
      for (const listener of typeListeners) {
        try {
          listener(event);
        } catch (error) {
          console.error('[ConsensusEvents] Error in listener:', error);
        }
      }
    }

    // Notify all listeners
    for (const listener of this.allListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[ConsensusEvents] Error in listener:', error);
      }
    }

    return event;
  }

  /**
   * Emit round started event
   */
  emitRoundStarted(
    roundId: string,
    peerId: PeerId,
    contributionId: string,
    witnesses: PeerId[],
    quorumRequired: number,
  ): RoundStartedEvent {
    const event = this.emit('ROUND_STARTED', roundId, peerId, {
      contributionId,
      witnesses,
      quorumRequired,
    }) as RoundStartedEvent;
    return event;
  }

  /**
   * Emit round voting event
   */
  emitRoundVoting(
    roundId: string,
    peerId: PeerId,
    votesReceived: number,
    votesRequired: number,
  ): RoundVotingEvent {
    const event = this.emit('ROUND_VOTING', roundId, peerId, {
      votesReceived,
      votesRequired,
    }) as RoundVotingEvent;
    return event;
  }

  /**
   * Emit round reached event
   */
  emitRoundReached(
    roundId: string,
    peerId: PeerId,
    result: 'approved' | 'rejected',
    approvalPercentage: number,
  ): RoundReachedEvent {
    const event = this.emit('ROUND_REACHED', roundId, peerId, {
      result,
      approvalPercentage,
    }) as RoundReachedEvent;
    return event;
  }

  /**
   * Emit round failed event
   */
  emitRoundFailed(roundId: string, peerId: PeerId, reason: string): RoundFailedEvent {
    const event = this.emit('ROUND_FAILED', roundId, peerId, {
      reason,
    }) as RoundFailedEvent;
    return event;
  }

  /**
   * Emit round expired event
   */
  emitRoundExpired(roundId: string, peerId: PeerId, timeout: number): RoundExpiredEvent {
    const event = this.emit('ROUND_EXPIRED', roundId, peerId, {
      timeout,
    }) as RoundExpiredEvent;
    return event;
  }

  /**
   * Emit vote cast event
   */
  emitVoteCast(
    roundId: string,
    peerId: PeerId,
    vote: VoteType,
    voter: PeerId,
    reason?: string,
  ): VoteCastEvent {
    const event = this.emit('VOTE_CAST', roundId, peerId, {
      vote,
      voter,
      reason,
    }) as VoteCastEvent;
    return event;
  }

  /**
   * Emit evidence submitted event
   */
  emitEvidenceSubmitted(
    roundId: string,
    peerId: PeerId,
    evidenceId: string,
    contributor: PeerId,
    contributionType: string,
  ): EvidenceSubmittedEvent {
    const event = this.emit('EVIDENCE_SUBMITTED', roundId, peerId, {
      evidenceId,
      contributor,
      contributionType,
    }) as EvidenceSubmittedEvent;
    return event;
  }

  /**
   * Emit witness selected event
   */
  emitWitnessSelected(
    roundId: string,
    peerId: PeerId,
    witness: PeerId,
    trustScore: number,
  ): WitnessSelectedEvent {
    const event = this.emit('WITNESS_SELECTED', roundId, peerId, {
      witness,
      trustScore,
    }) as WitnessSelectedEvent;
    return event;
  }

  /**
   * Emit quorum reached event
   */
  emitQuorumReached(
    roundId: string,
    peerId: PeerId,
    quorumPercentage: number,
    requiredPercentage: number,
  ): QuorumReachedEvent {
    const event = this.emit('QUORUM_REACHED', roundId, peerId, {
      quorumPercentage,
      requiredPercentage,
    }) as QuorumReachedEvent;
    return event;
  }

  /**
   * Emit fraud reported event
   */
  emitFraudReported(
    roundId: string,
    peerId: PeerId,
    accused: PeerId,
    fraudType: string,
    evidence: string[],
  ): FraudReportedEvent {
    const event = this.emit('FRAUD_REPORTED', roundId, peerId, {
      accused,
      fraudType,
      evidence,
    }) as FraudReportedEvent;
    return event;
  }

  /**
   * Emit proof generated event
   */
  emitProofGenerated(
    roundId: string,
    peerId: PeerId,
    proofId: string,
    contributionId: string,
    value: number,
  ): ProofGeneratedEvent {
    const event = this.emit('PROOF_GENERATED', roundId, peerId, {
      proofId,
      contributionId,
      value,
    }) as ProofGeneratedEvent;
    return event;
  }

  /**
   * Emit bundle created event
   */
  emitBundleCreated(
    roundId: string,
    peerId: PeerId,
    bundleId: string,
    contributionCount: number,
    totalValue: number,
  ): BundleCreatedEvent {
    const event = this.emit('BUNDLE_CREATED', roundId, peerId, {
      bundleId,
      contributionCount,
      totalValue,
    }) as BundleCreatedEvent;
    return event;
  }

  /**
   * Add listener for specific event type
   */
  on(type: ConsensusEventType, listener: (event: ConsensusEvent) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  /**
   * Add listener for all events
   */
  onAll(listener: (event: ConsensusEvent) => void): void {
    this.allListeners.add(listener);
  }

  /**
   * Remove listener for specific event type
   */
  off(type: ConsensusEventType, listener: (event: ConsensusEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  /**
   * Remove listener for all events
   */
  offAll(listener: (event: ConsensusEvent) => void): void {
    this.allListeners.delete(listener);
  }

  /**
   * Get events for a round
   */
  getEventsForRound(roundId: string, limit?: number): ConsensusEvent[] {
    const roundEvents = this.events.filter((e) => e.roundId === roundId);
    if (limit) {
      return roundEvents.slice(-limit);
    }
    return roundEvents;
  }

  /**
   * Get events by type
   */
  getEventsByType(type: ConsensusEventType, limit?: number): ConsensusEvent[] {
    const typeEvents = this.events.filter((e) => e.type === type);
    if (limit) {
      return typeEvents.slice(-limit);
    }
    return typeEvents;
  }

  /**
   * Get all events
   */
  getAllEvents(limit?: number): ConsensusEvent[] {
    if (limit) {
      return this.events.slice(-limit);
    }
    return this.events;
  }

  /**
   * Get events in time range
   */
  getEventsInTimeRange(startTime: number, endTime: number): ConsensusEvent[] {
    return this.events.filter((e) => e.timestamp >= startTime && e.timestamp <= endTime);
  }

  /**
   * Get event count for a round
   */
  getEventCountForRound(roundId: string): number {
    return this.events.filter((e) => e.roundId === roundId).length;
  }

  /**
   * Get event count by type
   */
  getEventCountByType(type: ConsensusEventType): number {
    return this.events.filter((e) => e.type === type).length;
  }

  /**
   * Clear all events
   */
  clearAll(): void {
    this.events = [];
  }

  /**
   * Clear events for a round
   */
  clearForRound(roundId: string): void {
    this.events = this.events.filter((e) => e.roundId !== roundId);
  }

  /**
   * Clear events by type
   */
  clearByType(type: ConsensusEventType): void {
    this.events = this.events.filter((e) => e.type !== type);
  }

  /**
   * Get total event count
   */
  getCount(): number {
    return this.events.length;
  }

  /**
   * Get listener count
   */
  getListenerCount(): number {
    let count = this.allListeners.size;
    for (const listeners of this.listeners.values()) {
      count += listeners.size;
    }
    return count;
  }

  /**
   * Remove all listeners
   */
  removeAllListeners(): void {
    this.listeners.clear();
    this.allListeners.clear();
  }
}
