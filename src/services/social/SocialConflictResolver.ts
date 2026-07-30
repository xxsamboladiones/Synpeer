import type { BaseModel } from '@/models/BaseModel';

import { isValidSocialRevisionMetadata, getSocialRevision } from './SocialCanonical';

export const MAX_SOCIAL_TIMESTAMP_FUTURE_SKEW_MS = 10 * 60 * 1000;
export const SOCIAL_TOMBSTONE_MIN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type SocialConflictEntity = 'post' | 'profile' | 'comment' | 'reaction' | 'follow' | 'chat';

export type SocialConflictAction = 'apply' | 'keep' | 'reject';

export type SocialConflictReason =
  | 'no_local_record'
  | 'duplicate'
  | 'author_mismatch'
  | 'identity_mismatch'
  | 'invalid_revision'
  | 'timestamp_out_of_range'
  | 'higher_revision'
  | 'revision_gap'
  | 'previous_revision_mismatch'
  | 'lower_revision'
  | 'final_tombstone'
  | 'tombstone_wins'
  | 'canonical_hash_wins'
  | 'canonical_hash_loses';

export interface SocialConflictRecord extends BaseModel {
  deleted?: boolean;
}

export interface SocialConflictResolution {
  action: SocialConflictAction;
  reason: SocialConflictReason;
  winnerStateHash: string;
  conflict: boolean;
}

export interface ResolveSocialConflictInput {
  entity: SocialConflictEntity;
  existing: SocialConflictRecord | null;
  incoming: SocialConflictRecord;
  existingStateHash?: string;
  incomingStateHash: string;
  now?: number;
  maxFutureSkewMs?: number;
}

export function resolveSocialConflict(input: ResolveSocialConflictInput): SocialConflictResolution {
  const now = input.now ?? Date.now();
  const timestampReason = validateTimestamp(
    input.incoming,
    now,
    input.maxFutureSkewMs ?? MAX_SOCIAL_TIMESTAMP_FUTURE_SKEW_MS,
  );
  if (timestampReason) {
    return reject(timestampReason, input.existingStateHash ?? input.incomingStateHash);
  }
  if (!isValidSocialRevisionMetadata(input.incoming)) {
    return reject('invalid_revision', input.existingStateHash ?? input.incomingStateHash);
  }
  if (!input.existing) {
    return {
      action: 'apply',
      reason: 'no_local_record',
      winnerStateHash: input.incomingStateHash,
      conflict: false,
    };
  }

  const existingStateHash = input.existingStateHash;
  if (!existingStateHash) {
    return reject('invalid_revision', input.incomingStateHash);
  }
  if (input.existing.author !== input.incoming.author) {
    return reject('author_mismatch', existingStateHash);
  }
  if (!hasStableIdentity(input.entity, input.existing, input.incoming)) {
    return reject('identity_mismatch', existingStateHash);
  }
  if (existingStateHash === input.incomingStateHash) {
    return {
      action: 'keep',
      reason: 'duplicate',
      winnerStateHash: existingStateHash,
      conflict: false,
    };
  }

  const existingDeleted = input.existing.deleted === true;
  const incomingDeleted = input.incoming.deleted === true;
  if (existingDeleted && !incomingDeleted && hasFinalTombstone(input.entity)) {
    return {
      action: 'keep',
      reason: 'final_tombstone',
      winnerStateHash: existingStateHash,
      conflict: true,
    };
  }

  const existingRevision = getSocialRevision(input.existing);
  const incomingRevision = getSocialRevision(input.incoming);
  if (incomingRevision > existingRevision) {
    const gap = incomingRevision - existingRevision;
    const previousMismatch =
      gap === 1 &&
      input.incoming.previousRevisionHash !== undefined &&
      input.incoming.previousRevisionHash !== existingStateHash;
    return {
      action: 'apply',
      reason: previousMismatch
        ? 'previous_revision_mismatch'
        : gap > 1
          ? 'revision_gap'
          : 'higher_revision',
      winnerStateHash: input.incomingStateHash,
      conflict: previousMismatch || gap > 1,
    };
  }
  if (incomingRevision < existingRevision) {
    return {
      action: 'keep',
      reason: 'lower_revision',
      winnerStateHash: existingStateHash,
      conflict: true,
    };
  }

  if (existingDeleted !== incomingDeleted) {
    return incomingDeleted
      ? {
          action: 'apply',
          reason: 'tombstone_wins',
          winnerStateHash: input.incomingStateHash,
          conflict: true,
        }
      : {
          action: 'keep',
          reason: 'tombstone_wins',
          winnerStateHash: existingStateHash,
          conflict: true,
        };
  }

  const incomingWins = input.incomingStateHash.localeCompare(existingStateHash) > 0;
  return {
    action: incomingWins ? 'apply' : 'keep',
    reason: incomingWins ? 'canonical_hash_wins' : 'canonical_hash_loses',
    winnerStateHash: incomingWins ? input.incomingStateHash : existingStateHash,
    conflict: true,
  };
}

export function canPurgeSocialTombstone(
  record: Pick<SocialConflictRecord, 'deleted' | 'updatedAt'>,
  now = Date.now(),
): boolean {
  return record.deleted === true && now - record.updatedAt >= SOCIAL_TOMBSTONE_MIN_RETENTION_MS;
}

function validateTimestamp(
  record: SocialConflictRecord,
  now: number,
  maxFutureSkewMs: number,
): 'timestamp_out_of_range' | null {
  if (
    !Number.isFinite(record.createdAt) ||
    !Number.isFinite(record.updatedAt) ||
    record.createdAt <= 0 ||
    record.updatedAt < record.createdAt ||
    record.createdAt > now + maxFutureSkewMs ||
    record.updatedAt > now + maxFutureSkewMs
  ) {
    return 'timestamp_out_of_range';
  }
  return null;
}

function hasStableIdentity(
  entity: SocialConflictEntity,
  existing: SocialConflictRecord,
  incoming: SocialConflictRecord,
): boolean {
  if (existing.id !== incoming.id || existing.createdAt !== incoming.createdAt) {
    return false;
  }
  switch (entity) {
    case 'post':
      return equalOptional(readProperty(existing, 'replyTo'), readProperty(incoming, 'replyTo'));
    case 'profile':
      return true;
    case 'comment':
      return (
        readProperty(existing, 'postId') === readProperty(incoming, 'postId') &&
        equalOptional(
          readProperty(existing, 'parentCommentId'),
          readProperty(incoming, 'parentCommentId'),
        )
      );
    case 'reaction':
      return (
        readProperty(existing, 'postId') === readProperty(incoming, 'postId') &&
        equalOptional(readProperty(existing, 'commentId'), readProperty(incoming, 'commentId')) &&
        readProperty(existing, 'reactionType') === readProperty(incoming, 'reactionType')
      );
    case 'follow':
      return (
        readProperty(existing, 'followerId') === readProperty(incoming, 'followerId') &&
        readProperty(existing, 'followingId') === readProperty(incoming, 'followingId')
      );
    case 'chat':
      return (
        readProperty(existing, 'senderId') === readProperty(incoming, 'senderId') &&
        readProperty(existing, 'recipientId') === readProperty(incoming, 'recipientId') &&
        readProperty(existing, 'conversationId') === readProperty(incoming, 'conversationId')
      );
  }
}

function hasFinalTombstone(entity: SocialConflictEntity): boolean {
  return entity === 'post' || entity === 'comment' || entity === 'chat';
}

function equalOptional(left: unknown, right: unknown): boolean {
  return (left ?? null) === (right ?? null);
}

function readProperty(record: SocialConflictRecord, key: string): unknown {
  return Reflect.get(record, key) as unknown;
}

function reject(
  reason: Extract<
    SocialConflictReason,
    'author_mismatch' | 'identity_mismatch' | 'invalid_revision' | 'timestamp_out_of_range'
  >,
  winnerStateHash: string,
): SocialConflictResolution {
  return {
    action: 'reject',
    reason,
    winnerStateHash,
    conflict: true,
  };
}
