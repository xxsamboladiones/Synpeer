import type { DatabaseService } from '@/database/DatabaseService';
import { AppError } from '@/errors/AppError';
import { createLogger } from '@/observability/Logger';

import type { ConsensusRound, ContributionVote } from './ConsensusTypes';
import type { QuorumResult } from './QuorumManager';

const CONSENSUS_SNAPSHOT_ID = 'local-consensus';

export interface ConsensusSnapshot {
  version: 1;
  rounds: ConsensusRound[];
  votes: ContributionVote[];
  quorumHistory: Array<[string, QuorumResult]>;
  capturedAt: number;
}

interface ConsensusSnapshotRow {
  id: string;
  updatedAt: number;
  data: string;
}

export class ConsensusRepository {
  private readonly logger = createLogger('consensus.repository');

  constructor(private readonly database: DatabaseService) {}

  async initialize(): Promise<void> {
    await this.database.run(`
      CREATE TABLE IF NOT EXISTS consensus_snapshots (
        id TEXT PRIMARY KEY,
        updatedAt INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
  }

  async saveSnapshot(snapshot: ConsensusSnapshot): Promise<void> {
    await this.database.run(
      `
      INSERT OR REPLACE INTO consensus_snapshots
      (id, updatedAt, data)
      VALUES (?, ?, ?);
    `,
      [CONSENSUS_SNAPSHOT_ID, snapshot.capturedAt, JSON.stringify(snapshot)],
    );
  }

  async loadSnapshot(): Promise<ConsensusSnapshot | null> {
    const rows = await this.database.query('SELECT * FROM consensus_snapshots WHERE id = ?;', [
      CONSENSUS_SNAPSHOT_ID,
    ]);
    const row = rows[0];
    if (!isConsensusSnapshotRow(row)) {
      return null;
    }

    try {
      const parsed = JSON.parse(row.data);
      return isConsensusSnapshot(parsed) ? parsed : null;
    } catch (error) {
      this.logger.error('snapshot_corrupt', error);
      return null;
    }
  }

  async reset(): Promise<void> {
    await this.database.run('DELETE FROM consensus_snapshots WHERE id = ?;', [
      CONSENSUS_SNAPSHOT_ID,
    ]);
  }
}

export function consensusPersistenceError(error: unknown): AppError {
  return new AppError({
    code: 'CONSENSUS_ERROR',
    message: error instanceof Error ? error.message : 'Consensus persistence failed',
    safeMessage: 'Nao foi possivel salvar o estado de consenso local.',
    severity: 'error',
    retryable: true,
    cause: error,
    context: {
      scope: 'consensus.repository',
      operation: 'persist',
    },
  });
}

function isConsensusSnapshotRow(value: unknown): value is ConsensusSnapshotRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' && typeof row.updatedAt === 'number' && typeof row.data === 'string'
  );
}

function isConsensusSnapshot(value: unknown): value is ConsensusSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const snapshot = value as Record<string, unknown>;
  return (
    snapshot.version === 1 &&
    Array.isArray(snapshot.rounds) &&
    snapshot.rounds.every(isConsensusRound) &&
    Array.isArray(snapshot.votes) &&
    snapshot.votes.every(isContributionVote) &&
    Array.isArray(snapshot.quorumHistory) &&
    snapshot.quorumHistory.every(isQuorumEntry) &&
    typeof snapshot.capturedAt === 'number'
  );
}

function isConsensusRound(value: unknown): value is ConsensusRound {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const round = value as Record<string, unknown>;
  return (
    typeof round.roundId === 'string' &&
    typeof round.contributionId === 'string' &&
    isConsensusStatus(round.status) &&
    typeof round.startTime === 'number' &&
    Array.isArray(round.witnesses) &&
    round.witnesses.every((witness) => typeof witness === 'string') &&
    Array.isArray(round.votes) &&
    round.votes.every(isContributionVote) &&
    typeof round.quorumRequired === 'number' &&
    typeof round.quorumReached === 'boolean' &&
    typeof round.approvalPercentage === 'number'
  );
}

function isContributionVote(value: unknown): value is ContributionVote {
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

function isQuorumEntry(value: unknown): value is [string, QuorumResult] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    isQuorumResult(value[1])
  );
}

function isQuorumResult(value: unknown): value is QuorumResult {
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

function isConsensusStatus(value: unknown): boolean {
  return (
    value === 'pending' ||
    value === 'voting' ||
    value === 'reached' ||
    value === 'failed' ||
    value === 'expired'
  );
}
