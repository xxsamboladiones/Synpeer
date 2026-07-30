import type { DatabaseService } from '@/database/DatabaseService';
import { AppError } from '@/errors/AppError';
import type { PeerId } from '@/network/NetworkTypes';
import { sha256Hex } from '@/utils/hash';

import type {
  SocialConflictAction,
  SocialConflictEntity,
  SocialConflictReason,
  SocialConflictResolution,
} from './SocialConflictResolver';

const TABLE_NAME = 'social_conflict_decisions';

export interface SocialConflictDecision {
  id: string;
  entity: SocialConflictEntity;
  entityId: string;
  localStateHash?: string;
  incomingStateHash: string;
  winnerStateHash: string;
  action: SocialConflictAction;
  reason: SocialConflictReason;
  peerId?: PeerId;
  decidedAt: number;
}

interface SocialConflictDecisionRow {
  id: string;
  entity: string;
  entityId: string;
  localStateHash: string | null;
  incomingStateHash: string;
  winnerStateHash: string;
  action: string;
  reason: string;
  peerId: string | null;
  decidedAt: number;
}

export class SocialConflictDecisionRepository {
  private readonly initialized: Promise<void>;

  constructor(private readonly database: DatabaseService) {
    this.initialized = this.initializeTable();
  }

  async record(input: {
    entity: SocialConflictEntity;
    entityId: string;
    localStateHash?: string;
    incomingStateHash: string;
    resolution: SocialConflictResolution;
    peerId?: PeerId;
    decidedAt?: number;
  }): Promise<SocialConflictDecision> {
    await this.initialized;
    const decidedAt = input.decidedAt ?? Date.now();
    const id = sha256Hex(
      [
        input.entity,
        input.entityId,
        input.localStateHash ?? '',
        input.incomingStateHash,
        input.resolution.winnerStateHash,
        input.resolution.action,
        input.resolution.reason,
      ].join(':'),
    );
    const decision: SocialConflictDecision = {
      id,
      entity: input.entity,
      entityId: input.entityId,
      localStateHash: input.localStateHash,
      incomingStateHash: input.incomingStateHash,
      winnerStateHash: input.resolution.winnerStateHash,
      action: input.resolution.action,
      reason: input.resolution.reason,
      peerId: input.peerId,
      decidedAt,
    };
    await this.database.run(
      `
      INSERT OR REPLACE INTO ${TABLE_NAME}
      (id, entity, entityId, localStateHash, incomingStateHash, winnerStateHash, action, reason, peerId, decidedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      [
        decision.id,
        decision.entity,
        decision.entityId,
        decision.localStateHash ?? null,
        decision.incomingStateHash,
        decision.winnerStateHash,
        decision.action,
        decision.reason,
        decision.peerId ?? null,
        decision.decidedAt,
      ],
    );
    return decision;
  }

  async list(entityId?: string): Promise<SocialConflictDecision[]> {
    await this.initialized;
    const rows = entityId
      ? await this.database.query(`SELECT * FROM ${TABLE_NAME} WHERE entityId = ?;`, [entityId])
      : await this.database.query(`SELECT * FROM ${TABLE_NAME};`);
    return rows.map(mapDecisionRow).sort((left, right) => left.decidedAt - right.decidedAt);
  }

  async clear(): Promise<void> {
    await this.initialized;
    await this.database.run(`DELETE FROM ${TABLE_NAME};`);
  }

  private async initializeTable(): Promise<void> {
    await this.database.execute(`
      CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
        id TEXT PRIMARY KEY,
        entity TEXT NOT NULL,
        entityId TEXT NOT NULL,
        localStateHash TEXT,
        incomingStateHash TEXT NOT NULL,
        winnerStateHash TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        peerId TEXT,
        decidedAt INTEGER NOT NULL
      );
    `);
    await this.database.execute(
      `CREATE INDEX IF NOT EXISTS idx_social_conflict_entity ON ${TABLE_NAME}(entity, entityId);`,
    );
  }
}

function mapDecisionRow(value: unknown): SocialConflictDecision {
  if (!isDecisionRow(value)) {
    throw new AppError({
      code: 'STORAGE_ERROR',
      message: 'Stored social conflict decision is corrupt',
      safeMessage: 'Um registro local de conflito social esta corrompido.',
      severity: 'error',
      retryable: false,
      context: {
        scope: 'social.conflicts',
        operation: 'read',
      },
    });
  }
  return {
    id: value.id,
    entity: value.entity,
    entityId: value.entityId,
    localStateHash: value.localStateHash ?? undefined,
    incomingStateHash: value.incomingStateHash,
    winnerStateHash: value.winnerStateHash,
    action: value.action,
    reason: value.reason,
    peerId: value.peerId ? (value.peerId as PeerId) : undefined,
    decidedAt: value.decidedAt,
  };
}

function isDecisionRow(
  value: unknown,
): value is SocialConflictDecisionRow & SocialConflictDecision {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    isEntity(row.entity) &&
    typeof row.entityId === 'string' &&
    isOptionalString(row.localStateHash) &&
    typeof row.incomingStateHash === 'string' &&
    typeof row.winnerStateHash === 'string' &&
    isAction(row.action) &&
    isReason(row.reason) &&
    isOptionalString(row.peerId) &&
    typeof row.decidedAt === 'number' &&
    Number.isFinite(row.decidedAt)
  );
}

function isOptionalString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === 'string';
}

function isEntity(value: unknown): value is SocialConflictEntity {
  return (
    value === 'post' ||
    value === 'profile' ||
    value === 'comment' ||
    value === 'reaction' ||
    value === 'follow' ||
    value === 'chat'
  );
}

function isAction(value: unknown): value is SocialConflictAction {
  return value === 'apply' || value === 'keep' || value === 'reject';
}

function isReason(value: unknown): value is SocialConflictReason {
  return (
    value === 'no_local_record' ||
    value === 'duplicate' ||
    value === 'author_mismatch' ||
    value === 'identity_mismatch' ||
    value === 'invalid_revision' ||
    value === 'timestamp_out_of_range' ||
    value === 'higher_revision' ||
    value === 'revision_gap' ||
    value === 'previous_revision_mismatch' ||
    value === 'lower_revision' ||
    value === 'final_tombstone' ||
    value === 'tombstone_wins' ||
    value === 'canonical_hash_wins' ||
    value === 'canonical_hash_loses'
  );
}
