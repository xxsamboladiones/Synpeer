import type { PeerId } from '@/network/NetworkTypes';

import {
  canPurgeSocialTombstone,
  MAX_SOCIAL_TIMESTAMP_FUTURE_SKEW_MS,
  resolveSocialConflict,
  SOCIAL_TOMBSTONE_MIN_RETENTION_MS,
  type SocialConflictRecord,
} from '../SocialConflictResolver';

const NOW = 2_000_000;

function createRecord(overrides: Partial<SocialConflictRecord> = {}): SocialConflictRecord {
  return {
    id: 'post-1',
    author: 'peer-a' as PeerId,
    createdAt: 1_000,
    updatedAt: 1_000,
    signature: 'signature',
    version: '3.0.0',
    revision: 1,
    deleted: false,
    ...overrides,
  };
}

describe('SocialConflictResolver', () => {
  it('uses logical revision instead of timestamps', () => {
    const existing = createRecord({ revision: 2, updatedAt: 10_000 });
    const incoming = createRecord({
      revision: 3,
      previousRevisionHash: 'a'.repeat(64),
      updatedAt: 2_000,
    });

    expect(
      resolveSocialConflict({
        entity: 'post',
        existing,
        incoming,
        existingStateHash: 'a'.repeat(64),
        incomingStateHash: 'b'.repeat(64),
        now: NOW,
      }),
    ).toMatchObject({
      action: 'apply',
      reason: 'higher_revision',
      winnerStateHash: 'b'.repeat(64),
    });
  });

  it('selects the same canonical hash regardless of arrival order', () => {
    const left = createRecord({ signature: 'left' });
    const right = createRecord({ signature: 'right' });
    const lowHash = '1'.repeat(64);
    const highHash = 'f'.repeat(64);

    const forward = resolveSocialConflict({
      entity: 'post',
      existing: left,
      incoming: right,
      existingStateHash: lowHash,
      incomingStateHash: highHash,
      now: NOW,
    });
    const reverse = resolveSocialConflict({
      entity: 'post',
      existing: right,
      incoming: left,
      existingStateHash: highHash,
      incomingStateHash: lowHash,
      now: NOW,
    });

    expect(forward).toMatchObject({ action: 'apply', winnerStateHash: highHash });
    expect(reverse).toMatchObject({ action: 'keep', winnerStateHash: highHash });
  });

  it('makes a tombstone win a same-revision fork and prevents post resurrection', () => {
    const active = createRecord();
    const tombstone = createRecord({ deleted: true });
    const tombstoneHash = 'f'.repeat(64);

    expect(
      resolveSocialConflict({
        entity: 'post',
        existing: active,
        incoming: tombstone,
        existingStateHash: 'e'.repeat(64),
        incomingStateHash: tombstoneHash,
        now: NOW,
      }),
    ).toMatchObject({ action: 'apply', reason: 'tombstone_wins' });

    expect(
      resolveSocialConflict({
        entity: 'post',
        existing: tombstone,
        incoming: createRecord({
          revision: 99,
          previousRevisionHash: tombstoneHash,
          updatedAt: 1_500,
        }),
        existingStateHash: tombstoneHash,
        incomingStateHash: '0'.repeat(64),
        now: NOW,
      }),
    ).toMatchObject({ action: 'keep', reason: 'final_tombstone' });
  });

  it('records an adjacent previous revision mismatch without using arrival order', () => {
    expect(
      resolveSocialConflict({
        entity: 'profile',
        existing: createRecord({ id: 'profile_peer-a' }),
        incoming: createRecord({
          id: 'profile_peer-a',
          revision: 2,
          previousRevisionHash: 'b'.repeat(64),
          updatedAt: 1_001,
        }),
        existingStateHash: 'a'.repeat(64),
        incomingStateHash: 'c'.repeat(64),
        now: NOW,
      }),
    ).toMatchObject({
      action: 'apply',
      reason: 'previous_revision_mismatch',
      conflict: true,
    });
  });

  it('rejects ownership changes and timestamps too far in the future', () => {
    expect(
      resolveSocialConflict({
        entity: 'post',
        existing: createRecord(),
        incoming: createRecord({ author: 'peer-b' as PeerId }),
        existingStateHash: 'a'.repeat(64),
        incomingStateHash: 'b'.repeat(64),
        now: NOW,
      }),
    ).toMatchObject({ action: 'reject', reason: 'author_mismatch' });

    expect(
      resolveSocialConflict({
        entity: 'post',
        existing: null,
        incoming: createRecord({
          createdAt: NOW + MAX_SOCIAL_TIMESTAMP_FUTURE_SKEW_MS + 1,
          updatedAt: NOW + MAX_SOCIAL_TIMESTAMP_FUTURE_SKEW_MS + 1,
        }),
        incomingStateHash: 'b'.repeat(64),
        now: NOW,
      }),
    ).toMatchObject({ action: 'reject', reason: 'timestamp_out_of_range' });
  });

  it('keeps tombstones for the configured anti-entropy horizon', () => {
    const tombstone = createRecord({ deleted: true, updatedAt: 1_000 });

    expect(canPurgeSocialTombstone(tombstone, 1_000 + SOCIAL_TOMBSTONE_MIN_RETENTION_MS - 1)).toBe(
      false,
    );
    expect(canPurgeSocialTombstone(tombstone, 1_000 + SOCIAL_TOMBSTONE_MIN_RETENTION_MS)).toBe(
      true,
    );
  });
});
