import type { ConsensusEngine } from '@/consensus/ConsensusEngine';
import type { ContributionType } from '@/consensus/ConsensusTypes';
import type { NetworkMessage } from '@/network/NetworkMessage';
import type { PeerConnection, PeerTransport } from '@/network/PeerTransport';
import type { PeerId } from '@/network/NetworkTypes';
import type { TrustedPeerRepository } from '@/services/peers/TrustedPeerRepository';

import { getConsensusVoteSignableBytes, type ConsensusCryptoProvider } from './ConsensusVoteCrypto';

export interface ConsensusProposalPayload {
  version: 1;
  type: 'consensus.proposal';
  roundId: string;
  contributionId: string;
  contributor: PeerId;
  contributionType: ContributionType;
  value: number;
  proposedAt: number;
}

export interface ConsensusVotePayload {
  version: 1;
  type: 'consensus.vote';
  roundId: string;
  contributionId: string;
  voter: PeerId;
  vote: 'approve' | 'reject' | 'abstain';
  reason?: string;
  publicKey: string;
  signature: string;
  votedAt: number;
}

export interface ConsensusResultPayload {
  version: 1;
  type: 'consensus.result';
  roundId: string;
  contributionId: string;
  result: 'approved' | 'rejected' | 'pending';
  approvalPercentage: number;
  decidedAt: number;
}

export class PeerConsensusProtocol {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly localPeerId: PeerId,
    private readonly transport: PeerTransport,
    private readonly consensusEngine: ConsensusEngine,
    private readonly trustedPeers: TrustedPeerRepository,
    private readonly crypto: ConsensusCryptoProvider,
  ) {}

  start(): void {
    if (this.unsubscribe) {
      return;
    }
    this.unsubscribe = this.transport.subscribe(async (message, connection) => {
      await this.handleMessage(message, connection);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async proposeContribution(input: {
    contributionId: string;
    contributor: PeerId;
    type: ContributionType;
    value: number;
    targetPeerIds?: readonly PeerId[];
  }): Promise<string> {
    const round = this.consensusEngine.startContributionRound(
      input.contributionId,
      input.contributor,
      input.type,
      input.value,
    );
    round.start();
    const roundState = round.getRound();
    const proposal: ConsensusProposalPayload = {
      version: 1,
      type: 'consensus.proposal',
      roundId: roundState.roundId,
      contributionId: input.contributionId,
      contributor: input.contributor,
      contributionType: input.type,
      value: input.value,
      proposedAt: roundState.startTime,
    };

    const targets = input.targetPeerIds ?? this.transport.getConnectedPeers();
    for (const peerId of targets) {
      if (this.isVerified(peerId)) {
        await this.transport.getConnection(peerId)?.send('consensus.proposal', proposal, {
          correlationId: roundState.roundId,
        });
      }
    }
    return roundState.roundId;
  }

  private async handleMessage(message: NetworkMessage, connection: PeerConnection): Promise<void> {
    if (!this.isVerified(connection.peerId)) {
      return;
    }
    if (message.messageType === 'consensus.proposal' && isProposalPayload(message.payload)) {
      await this.handleProposal(message.payload, connection);
      return;
    }
    if (message.messageType === 'consensus.vote' && isVotePayload(message.payload)) {
      await this.handleVote(message.payload, connection);
      return;
    }
    if (message.messageType === 'consensus.result' && isResultPayload(message.payload)) {
      this.handleResult(message.payload, connection);
    }
  }

  private async handleProposal(
    proposal: ConsensusProposalPayload,
    connection: PeerConnection,
  ): Promise<void> {
    const round = this.consensusEngine.startContributionRound(
      proposal.contributionId,
      proposal.contributor,
      proposal.contributionType,
      proposal.value,
      { roundId: proposal.roundId, startedAt: proposal.proposedAt },
    );
    if (round.getStatus() === 'pending') {
      round.start();
    }

    const vote = await this.createVotePayload(proposal, 'approve');
    this.consensusEngine.recordVerifiedVote(vote);
    await connection.send('consensus.vote', vote, { correlationId: proposal.roundId });
  }

  private async handleVote(
    payload: ConsensusVotePayload,
    connection: PeerConnection,
  ): Promise<void> {
    if (payload.voter !== connection.peerId) {
      return;
    }
    const trustedPeer = this.trustedPeers.get(connection.peerId);
    if (trustedPeer?.publicKey && trustedPeer.publicKey !== payload.publicKey) {
      return;
    }

    const verified = await this.crypto.verify(
      getConsensusVoteSignableBytes(payload),
      payload.signature,
      payload.publicKey,
    );
    if (!verified) {
      return;
    }

    const applied = this.consensusEngine.recordVerifiedVote(payload);
    if (applied) {
      await this.broadcastResultIfComplete(payload.roundId);
    }
  }

  private handleResult(payload: ConsensusResultPayload, connection: PeerConnection): void {
    if (!this.isVerified(connection.peerId)) {
      return;
    }
    this.consensusEngine.recordExternalResult(payload);
  }

  private async createVotePayload(
    proposal: ConsensusProposalPayload,
    vote: 'approve' | 'reject' | 'abstain',
    reason?: string,
  ): Promise<ConsensusVotePayload> {
    const votedAt = Date.now();
    const publicKey = this.crypto.getPublicIdentity();
    if (!publicKey) {
      throw new Error('Cannot create consensus vote without a local identity');
    }
    const unsigned = {
      roundId: proposal.roundId,
      contributionId: proposal.contributionId,
      voter: this.localPeerId,
      vote,
      votedAt,
    };
    const signature = await this.crypto.sign(getConsensusVoteSignableBytes(unsigned));
    return {
      version: 1,
      type: 'consensus.vote',
      ...unsigned,
      reason,
      publicKey,
      signature,
    };
  }

  private async broadcastResultIfComplete(roundId: string): Promise<void> {
    const round = this.consensusEngine.getRound(roundId);
    const state = round?.getRound();
    if (!state || state.status !== 'reached' || !state.result) {
      return;
    }

    const result: ConsensusResultPayload = {
      version: 1,
      type: 'consensus.result',
      roundId: state.roundId,
      contributionId: state.contributionId,
      result: state.result,
      approvalPercentage: state.approvalPercentage,
      decidedAt: state.endTime ?? Date.now(),
    };

    for (const peerId of this.transport.getConnectedPeers()) {
      if (this.isVerified(peerId)) {
        await this.transport.getConnection(peerId)?.send('consensus.result', result, {
          correlationId: roundId,
        });
      }
    }
  }

  private isVerified(peerId: PeerId): boolean {
    return this.trustedPeers.get(peerId)?.trustStatus === 'verified';
  }
}

function isProposalPayload(value: unknown): value is ConsensusProposalPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  return (
    payload.version === 1 &&
    payload.type === 'consensus.proposal' &&
    typeof payload.roundId === 'string' &&
    typeof payload.contributionId === 'string' &&
    typeof payload.contributor === 'string' &&
    isContributionType(payload.contributionType) &&
    typeof payload.value === 'number' &&
    typeof payload.proposedAt === 'number'
  );
}

function isVotePayload(value: unknown): value is ConsensusVotePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  return (
    payload.version === 1 &&
    payload.type === 'consensus.vote' &&
    typeof payload.roundId === 'string' &&
    typeof payload.contributionId === 'string' &&
    typeof payload.voter === 'string' &&
    (payload.vote === 'approve' || payload.vote === 'reject' || payload.vote === 'abstain') &&
    typeof payload.publicKey === 'string' &&
    typeof payload.signature === 'string' &&
    typeof payload.votedAt === 'number'
  );
}

function isResultPayload(value: unknown): value is ConsensusResultPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  return (
    payload.version === 1 &&
    payload.type === 'consensus.result' &&
    typeof payload.roundId === 'string' &&
    typeof payload.contributionId === 'string' &&
    (payload.result === 'approved' ||
      payload.result === 'rejected' ||
      payload.result === 'pending') &&
    typeof payload.approvalPercentage === 'number' &&
    typeof payload.decidedAt === 'number'
  );
}

function isContributionType(value: unknown): value is ContributionType {
  return (
    value === 'STORAGE' || value === 'BANDWIDTH' || value === 'VALIDATION' || value === 'WITNESS'
  );
}
