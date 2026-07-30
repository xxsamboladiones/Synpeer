import { canonicalize } from '@/economy/Wallet/TransactionModel';
import type { PeerId } from '@/network/NetworkTypes';

export interface ConsensusCryptoProvider {
  sign(data: string): Promise<string>;
  verify(data: string, signature: string, publicIdentity: string): Promise<boolean>;
  getPublicIdentity(): string | null;
}

export interface ConsensusVoteSignablePayload {
  roundId: string;
  contributionId: string;
  voter: PeerId;
  vote: 'approve' | 'reject' | 'abstain';
  reason?: string;
  votedAt: number;
}

export function getConsensusVoteSignableBytes(input: ConsensusVoteSignablePayload): string {
  return canonicalize({
    roundId: input.roundId,
    contributionId: input.contributionId,
    voter: input.voter,
    vote: input.vote,
    reason: input.reason ?? null,
    votedAt: input.votedAt,
  });
}
