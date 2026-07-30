import { AppError } from '@/errors/AppError';
import type { PeerId } from '@/network/NetworkTypes';
import type { ChatMessageData } from '@/models/ChatMessage';
import type { CommentData } from '@/models/Comment';
import type { FollowData } from '@/models/Follow';
import type { PostData } from '@/models/Post';
import type { ProfileData } from '@/models/Profile';
import type { ReactionData } from '@/models/Reaction';
import type { ChatMessageRepository } from '@/repositories/ChatMessageRepository';
import type { CommentRepository } from '@/repositories/CommentRepository';
import type { FollowRepository } from '@/repositories/FollowRepository';
import type { PostRepository } from '@/repositories/PostRepository';
import type { ProfileRepository } from '@/repositories/ProfileRepository';
import type { ReactionRepository } from '@/repositories/ReactionRepository';
import type { SocialApplicationService } from '@/services/social/SocialApplicationService';
import type { SocialEventBus } from '@/services/social/SocialEventBus';
import {
  getChatMessageStateHash,
  getCommentStateHash,
  getFollowStateHash,
  getPostStateHash,
  getProfileStateHash,
  getReactionStateHash,
} from '@/services/social/SocialCanonical';
import {
  resolveSocialConflict,
  type SocialConflictEntity,
  type SocialConflictRecord,
} from '@/services/social/SocialConflictResolver';
import type { TrustedPeerRepository } from '@/services/peers/TrustedPeerRepository';
import { sha256Hex } from '@/utils/hash';

import type { SyncCheckpointRepository } from './SyncCheckpointRepository';

export const SYNC_ENTITIES = ['post', 'profile', 'comment', 'reaction', 'follow', 'chat'] as const;

export type SyncEntity = (typeof SYNC_ENTITIES)[number];

export interface SyncCursor {
  updatedAt: number;
  id: string;
}

export interface SyncManifestItem {
  entity: SyncEntity;
  id: string;
  contentHash: string;
  stateHash: string;
  updatedAt: number;
  author: PeerId;
  deleted: boolean;
}

export interface IncrementalSyncManifest {
  version: 1;
  peerId: PeerId;
  cursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  items: SyncManifestItem[];
}

export interface IncrementalSyncBatch {
  version: 1 | 2;
  peerId: PeerId;
  entity?: SyncEntity;
  itemIds?: string[];
  cursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  posts: PostData[];
  profiles?: ProfileData[];
  comments?: CommentData[];
  reactions?: ReactionData[];
  follows?: FollowData[];
  chatMessages?: ChatMessageData[];
}

export interface EntitySyncManifest {
  version: 2;
  peerId: PeerId;
  entity: SyncEntity;
  cursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  rootHash: string;
  rangeHash: string;
  totalItems: number;
  items: SyncManifestItem[];
}

export interface IncrementalSyncResult {
  applied: number;
  skipped: number;
  nextCursor?: string;
  hasMore: boolean;
}

export class IncrementalSyncService {
  constructor(
    private readonly localPeerId: PeerId,
    private readonly postRepository: PostRepository,
    private readonly trustedPeers: TrustedPeerRepository,
    private readonly batchSize = 50,
    private readonly profileRepository?: ProfileRepository,
    private readonly socialApplicationService?: SocialApplicationService,
    private readonly commentRepository?: CommentRepository,
    private readonly reactionRepository?: ReactionRepository,
    private readonly followRepository?: FollowRepository,
    private readonly chatMessageRepository?: ChatMessageRepository,
    private readonly events?: SocialEventBus,
    private readonly checkpointRepository?: SyncCheckpointRepository,
  ) {}

  getCheckpointRepository(): SyncCheckpointRepository | undefined {
    return this.checkpointRepository;
  }

  async createManifest(cursor?: string, audiencePeerId?: PeerId): Promise<IncrementalSyncManifest> {
    const records = await this.getRecordsAfterCursor(cursor, audiencePeerId);
    const selected = records.slice(0, this.batchSize);
    return {
      version: 1,
      peerId: this.localPeerId,
      cursor,
      nextCursor: selected.length > 0 ? encodeCursor(selected[selected.length - 1]) : cursor,
      hasMore: records.length > selected.length,
      items: selected.map((record) => ({
        entity: record.entity,
        id: record.id,
        contentHash: record.contentHash,
        stateHash: record.stateHash,
        updatedAt: record.updatedAt,
        author: record.author,
        deleted: record.deleted,
      })),
    };
  }

  async createEntityManifest(
    entity: SyncEntity,
    cursor?: string,
    audiencePeerId?: PeerId,
  ): Promise<EntitySyncManifest> {
    const allRecords = await this.getRecordsForEntity(entity, audiencePeerId);
    const records = filterRecordsAfterCursor(allRecords, cursor);
    const selected = records.slice(0, this.batchSize);
    return {
      version: 2,
      peerId: this.localPeerId,
      entity,
      cursor,
      nextCursor: selected.length > 0 ? encodeCursor(selected[selected.length - 1]) : cursor,
      hasMore: records.length > selected.length,
      rootHash: hashManifestRecords(allRecords),
      rangeHash: hashManifestRecords(selected),
      totalItems: allRecords.length,
      items: selected.map(toManifestItem),
    };
  }

  async createEntityBatch(
    entity: SyncEntity,
    itemIds: readonly string[],
    audiencePeerId?: PeerId,
  ): Promise<IncrementalSyncBatch> {
    const requestedIds = new Set(itemIds.slice(0, this.batchSize));
    const records = (await this.getRecordsForEntity(entity, audiencePeerId)).filter((record) =>
      requestedIds.has(record.id),
    );
    return createBatchFromRecords(this.localPeerId, records, {
      version: 2,
      entity,
      itemIds: records.map((record) => record.id),
    });
  }

  async findMissingManifestItems(
    manifest: EntitySyncManifest,
    audiencePeerId: PeerId = this.localPeerId,
  ): Promise<SyncManifestItem[]> {
    const localManifest = await this.createEntityManifest(
      manifest.entity,
      manifest.cursor,
      audiencePeerId,
    );
    if (
      localManifest.rangeHash === manifest.rangeHash &&
      localManifest.items.length === manifest.items.length
    ) {
      return [];
    }
    const localRecords = await this.getRecordsForEntity(manifest.entity, audiencePeerId);
    const localById = new Map(localRecords.map((record) => [record.id, record]));
    return manifest.items.filter((remote) => {
      const local = localById.get(remote.id);
      if (!local) {
        return true;
      }
      return remote.stateHash !== local.stateHash;
    });
  }

  async getEntityRootHash(
    entity: SyncEntity,
    audiencePeerId: PeerId = this.localPeerId,
  ): Promise<string> {
    return hashManifestRecords(await this.getRecordsForEntity(entity, audiencePeerId));
  }

  isManifestRangeValid(manifest: EntitySyncManifest): boolean {
    return hashManifestItems(manifest.items) === manifest.rangeHash;
  }

  async createBatch(
    cursor?: string,
    maxItems: number = this.batchSize,
    audiencePeerId?: PeerId,
  ): Promise<IncrementalSyncBatch> {
    const records = await this.getRecordsAfterCursor(cursor, audiencePeerId);
    const selected = records.slice(0, Math.max(0, Math.min(maxItems, this.batchSize)));
    return createBatchFromRecords(this.localPeerId, selected, {
      version: 1,
      cursor,
      nextCursor: selected.length > 0 ? encodeCursor(selected[selected.length - 1]) : cursor,
      hasMore: records.length > selected.length,
    });
  }

  async applyBatch(peerId: PeerId, batch: IncrementalSyncBatch): Promise<IncrementalSyncResult> {
    if (batch.version !== 1 && batch.version !== 2) {
      throw new Error('Unsupported incremental sync batch version');
    }

    let applied = 0;
    let skipped = 0;
    for (const post of batch.posts) {
      const result = await this.applySafely('post', peerId, post.id, batch.version === 2, () =>
        this.applyPost(peerId, post),
      );
      applied += result.applied ? 1 : 0;
      skipped += result.skipped || result.conflict ? 1 : 0;
    }

    for (const profile of batch.profiles ?? []) {
      const result = await this.applySafely(
        'profile',
        peerId,
        profile.id,
        batch.version === 2,
        () => this.applyProfile(peerId, profile),
      );
      applied += result.applied ? 1 : 0;
      skipped += result.skipped || result.conflict ? 1 : 0;
    }

    for (const comment of batch.comments ?? []) {
      const result = await this.applySafely(
        'comment',
        peerId,
        comment.id,
        batch.version === 2,
        () => this.applyComment(peerId, comment),
      );
      applied += result.applied ? 1 : 0;
      skipped += result.skipped || result.conflict ? 1 : 0;
    }

    for (const reaction of batch.reactions ?? []) {
      const result = await this.applySafely(
        'reaction',
        peerId,
        reaction.id,
        batch.version === 2,
        () => this.applyReaction(peerId, reaction),
      );
      applied += result.applied ? 1 : 0;
      skipped += result.skipped || result.conflict ? 1 : 0;
    }

    for (const follow of batch.follows ?? []) {
      const result = await this.applySafely('follow', peerId, follow.id, batch.version === 2, () =>
        this.applyFollow(peerId, follow),
      );
      applied += result.applied ? 1 : 0;
      skipped += result.skipped || result.conflict ? 1 : 0;
    }

    for (const message of batch.chatMessages ?? []) {
      const result = await this.applySafely('chat', peerId, message.id, batch.version === 2, () =>
        this.applyChatMessage(peerId, message),
      );
      applied += result.applied ? 1 : 0;
      skipped += result.skipped || result.conflict ? 1 : 0;
    }

    if (batch.version === 1) {
      this.trustedPeers.recordSyncCursor(peerId, batch.nextCursor, applied);
    }
    if (applied > 0) {
      this.events?.emit({
        type: 'social.sync.completed',
        peerId,
        received: applied,
        timestamp: Date.now(),
      });
    }
    return {
      applied,
      skipped,
      nextCursor: batch.nextCursor,
      hasMore: batch.hasMore,
    };
  }

  private async applySafely(
    entity: SyncEntity,
    peerId: PeerId,
    entityId: string,
    strict: boolean,
    apply: () => Promise<{ applied: boolean; skipped: boolean; conflict: boolean }>,
  ): Promise<{ applied: boolean; skipped: boolean; conflict: boolean }> {
    try {
      return await apply();
    } catch (error) {
      this.events?.emit({
        type: 'social.conflict.detected',
        entity,
        entityId,
        peerId,
        timestamp: Date.now(),
      });
      if (strict && isRetryableApplyFailure(error)) {
        throw error;
      }
      return { applied: false, skipped: true, conflict: false };
    }
  }

  private async applyPost(
    peerId: PeerId,
    post: PostData,
  ): Promise<{ applied: boolean; skipped: boolean; conflict: boolean }> {
    if (this.socialApplicationService) {
      return await this.socialApplicationService.applyRemotePost(post, peerId);
    }

    const duplicateHash = await this.postRepository.getByContentHash(post.contentHash);
    const existing = await this.postRepository.getById(post.id);
    const conflictResult = resolveFallbackConflict(
      'post',
      existing,
      post,
      existing ? getPostStateHash(existing) : undefined,
      getPostStateHash(post),
    );
    if (conflictResult) {
      return conflictResult;
    }
    if (!existing && duplicateHash.length > 0) {
      return { applied: false, skipped: true, conflict: false };
    }
    if (existing) {
      await this.postRepository.update(post);
    } else {
      await this.postRepository.create(post);
    }
    return { applied: true, skipped: false, conflict: false };
  }

  private async applyProfile(
    peerId: PeerId,
    profile: ProfileData,
  ): Promise<{ applied: boolean; skipped: boolean; conflict: boolean }> {
    if (this.socialApplicationService) {
      return await this.socialApplicationService.applyRemoteProfile(profile, peerId);
    }
    if (!this.profileRepository) {
      return { applied: false, skipped: true, conflict: false };
    }

    const existing = await this.profileRepository.getByAuthor(profile.author);
    const conflictResult = resolveFallbackConflict(
      'profile',
      existing,
      profile,
      existing ? getProfileStateHash(existing) : undefined,
      getProfileStateHash(profile),
    );
    if (conflictResult) {
      return conflictResult;
    }
    if (existing) {
      await this.profileRepository.update(profile);
    } else {
      await this.profileRepository.create(profile);
    }
    return { applied: true, skipped: false, conflict: false };
  }

  private async applyComment(
    peerId: PeerId,
    comment: CommentData,
  ): Promise<{ applied: boolean; skipped: boolean; conflict: boolean }> {
    if (this.socialApplicationService) {
      return await this.socialApplicationService.applyRemoteComment(comment, peerId);
    }
    if (!this.commentRepository) {
      return { applied: false, skipped: true, conflict: false };
    }
    const existing = await this.commentRepository.getById(comment.id);
    const conflictResult = resolveFallbackConflict(
      'comment',
      existing,
      comment,
      existing ? getCommentStateHash(existing) : undefined,
      getCommentStateHash(comment),
    );
    if (conflictResult) {
      return conflictResult;
    }
    if (existing) {
      await this.commentRepository.update(comment);
    } else {
      await this.commentRepository.create(comment);
    }
    return { applied: true, skipped: false, conflict: false };
  }

  private async applyReaction(
    peerId: PeerId,
    reaction: ReactionData,
  ): Promise<{ applied: boolean; skipped: boolean; conflict: boolean }> {
    if (this.socialApplicationService) {
      return await this.socialApplicationService.applyRemoteReaction(reaction, peerId);
    }
    if (!this.reactionRepository) {
      return { applied: false, skipped: true, conflict: false };
    }
    const existing = await this.reactionRepository.getById(reaction.id);
    const conflictResult = resolveFallbackConflict(
      'reaction',
      existing,
      reaction,
      existing ? getReactionStateHash(existing) : undefined,
      getReactionStateHash(reaction),
    );
    if (conflictResult) {
      return conflictResult;
    }
    if (existing) {
      await this.reactionRepository.update(reaction);
    } else {
      await this.reactionRepository.create(reaction);
    }
    return { applied: true, skipped: false, conflict: false };
  }

  private async applyFollow(
    peerId: PeerId,
    follow: FollowData,
  ): Promise<{ applied: boolean; skipped: boolean; conflict: boolean }> {
    if (this.socialApplicationService) {
      return await this.socialApplicationService.applyRemoteFollow(follow, peerId);
    }
    if (!this.followRepository) {
      return { applied: false, skipped: true, conflict: false };
    }
    const existing = await this.followRepository.getById(follow.id);
    const conflictResult = resolveFallbackConflict(
      'follow',
      existing,
      follow,
      existing ? getFollowStateHash(existing) : undefined,
      getFollowStateHash(follow),
    );
    if (conflictResult) {
      return conflictResult;
    }
    if (existing) {
      await this.followRepository.update(follow);
    } else {
      await this.followRepository.create(follow);
    }
    return { applied: true, skipped: false, conflict: false };
  }

  private async applyChatMessage(
    peerId: PeerId,
    message: ChatMessageData,
  ): Promise<{ applied: boolean; skipped: boolean; conflict: boolean }> {
    if (this.socialApplicationService) {
      return await this.socialApplicationService.applyRemoteChatMessage(message, peerId);
    }
    if (!this.chatMessageRepository) {
      return { applied: false, skipped: true, conflict: false };
    }
    const existing = await this.chatMessageRepository.getById(message.id);
    const conflictResult = resolveFallbackConflict(
      'chat',
      existing,
      message,
      existing ? getChatMessageStateHash(existing) : undefined,
      getChatMessageStateHash(message),
    );
    if (conflictResult) {
      return conflictResult;
    }
    const duplicateHash = await this.chatMessageRepository.getByContentHash(message.contentHash);
    if (!existing && duplicateHash.length > 0) {
      return { applied: false, skipped: true, conflict: false };
    }
    if (existing) {
      await this.chatMessageRepository.update(message);
    } else {
      await this.chatMessageRepository.create(message);
    }
    return { applied: true, skipped: false, conflict: false };
  }

  private async getRecordsAfterCursor(
    cursor?: string,
    audiencePeerId?: PeerId,
  ): Promise<SyncRecord[]> {
    return filterRecordsAfterCursor(await this.getAllRecords(audiencePeerId), cursor);
  }

  private async getRecordsForEntity(
    entity: SyncEntity,
    audiencePeerId?: PeerId,
  ): Promise<SyncRecord[]> {
    return (await this.getAllRecords(audiencePeerId)).filter((record) => record.entity === entity);
  }

  private async getAllRecords(audiencePeerId?: PeerId): Promise<SyncRecord[]> {
    const posts = await listIncludingDeleted(this.postRepository);
    const profiles = this.profileRepository
      ? await listRepositoryRecords(this.profileRepository)
      : [];
    const comments = this.commentRepository
      ? await listIncludingDeleted(this.commentRepository)
      : [];
    const reactions = this.reactionRepository
      ? await listIncludingDeleted(this.reactionRepository)
      : [];
    const follows = this.followRepository ? await listIncludingDeleted(this.followRepository) : [];
    const chatMessages = this.chatMessageRepository
      ? await listIncludingDeleted(this.chatMessageRepository)
      : [];
    return [
      ...posts.map(toPostRecord),
      ...profiles.map(toProfileRecord),
      ...comments.map(toCommentRecord),
      ...reactions.map(toReactionRecord),
      ...follows.map(toFollowRecord),
      ...chatMessages
        .filter(
          (message) =>
            !message.relayOnly &&
            (!audiencePeerId ||
              message.senderId === audiencePeerId ||
              message.recipientId === audiencePeerId),
        )
        .map(toChatRecord),
    ].sort(compareRecordsAscending);
  }
}

type SyncRecord =
  | {
      entity: 'post';
      id: string;
      contentHash: string;
      stateHash: string;
      updatedAt: number;
      author: PeerId;
      deleted: boolean;
      data: PostData;
    }
  | {
      entity: 'profile';
      id: string;
      contentHash: string;
      stateHash: string;
      updatedAt: number;
      author: PeerId;
      deleted: false;
      data: ProfileData;
    }
  | {
      entity: 'comment';
      id: string;
      contentHash: string;
      stateHash: string;
      updatedAt: number;
      author: PeerId;
      deleted: boolean;
      data: CommentData;
    }
  | {
      entity: 'reaction';
      id: string;
      contentHash: string;
      stateHash: string;
      updatedAt: number;
      author: PeerId;
      deleted: boolean;
      data: ReactionData;
    }
  | {
      entity: 'follow';
      id: string;
      contentHash: string;
      stateHash: string;
      updatedAt: number;
      author: PeerId;
      deleted: boolean;
      data: FollowData;
    }
  | {
      entity: 'chat';
      id: string;
      contentHash: string;
      stateHash: string;
      updatedAt: number;
      author: PeerId;
      deleted: boolean;
      data: ChatMessageData;
    };

function isRetryableApplyFailure(error: unknown): boolean {
  return !(error instanceof AppError) || error.code !== 'VALIDATION_ERROR' || error.retryable;
}

function resolveFallbackConflict(
  entity: SocialConflictEntity,
  existing: SocialConflictRecord | null,
  incoming: SocialConflictRecord,
  existingStateHash: string | undefined,
  incomingStateHash: string,
): { applied: boolean; skipped: boolean; conflict: boolean } | null {
  const resolution = resolveSocialConflict({
    entity,
    existing,
    incoming,
    existingStateHash,
    incomingStateHash,
  });
  if (resolution.action === 'apply') {
    return null;
  }
  return {
    applied: false,
    skipped: resolution.action === 'keep',
    conflict: resolution.action === 'reject',
  };
}

export function encodeCursor(item: Pick<PostData, 'updatedAt' | 'id'>): string {
  return `${item.updatedAt}:${encodeURIComponent(item.id)}`;
}

export function decodeCursor(cursor: string | undefined): SyncCursor | null {
  if (!cursor) {
    return null;
  }
  const separator = cursor.indexOf(':');
  if (separator < 0) {
    return null;
  }
  const updatedAt = Number(cursor.slice(0, separator));
  const id = decodeURIComponent(cursor.slice(separator + 1));
  if (!Number.isFinite(updatedAt) || id.length === 0) {
    return null;
  }
  return { updatedAt, id };
}

function toPostRecord(post: PostData): SyncRecord {
  const contentHash = post.contentHash;
  return {
    entity: 'post',
    id: post.id,
    contentHash,
    stateHash: getPostStateHash(post),
    updatedAt: post.updatedAt,
    author: post.author,
    deleted: post.deleted,
    data: post,
  };
}

function toProfileRecord(profile: ProfileData): SyncRecord {
  const contentHash = profile.signature;
  return {
    entity: 'profile',
    id: profile.id,
    contentHash,
    stateHash: getProfileStateHash(profile),
    updatedAt: profile.updatedAt,
    author: profile.author,
    deleted: false,
    data: profile,
  };
}

function toCommentRecord(comment: CommentData): SyncRecord {
  const contentHash = comment.contentHash;
  return {
    entity: 'comment',
    id: comment.id,
    contentHash,
    stateHash: getCommentStateHash(comment),
    updatedAt: comment.updatedAt,
    author: comment.author,
    deleted: comment.deleted,
    data: comment,
  };
}

function toReactionRecord(reaction: ReactionData): SyncRecord {
  const contentHash = reaction.signature;
  return {
    entity: 'reaction',
    id: reaction.id,
    contentHash,
    stateHash: getReactionStateHash(reaction),
    updatedAt: reaction.updatedAt,
    author: reaction.author,
    deleted: reaction.deleted,
    data: reaction,
  };
}

function toFollowRecord(follow: FollowData): SyncRecord {
  const contentHash = follow.signature;
  return {
    entity: 'follow',
    id: follow.id,
    contentHash,
    stateHash: getFollowStateHash(follow),
    updatedAt: follow.updatedAt,
    author: follow.author,
    deleted: follow.deleted,
    data: follow,
  };
}

function toChatRecord(message: ChatMessageData): SyncRecord {
  const contentHash = message.contentHash;
  return {
    entity: 'chat',
    id: message.id,
    contentHash,
    stateHash: getChatMessageStateHash(message),
    updatedAt: message.updatedAt,
    author: message.senderId,
    deleted: message.deleted,
    data: message,
  };
}

function isPostRecord(record: SyncRecord): record is Extract<SyncRecord, { entity: 'post' }> {
  return record.entity === 'post';
}

function isProfileRecord(record: SyncRecord): record is Extract<SyncRecord, { entity: 'profile' }> {
  return record.entity === 'profile';
}

function isCommentRecord(record: SyncRecord): record is Extract<SyncRecord, { entity: 'comment' }> {
  return record.entity === 'comment';
}

function isReactionRecord(
  record: SyncRecord,
): record is Extract<SyncRecord, { entity: 'reaction' }> {
  return record.entity === 'reaction';
}

function isFollowRecord(record: SyncRecord): record is Extract<SyncRecord, { entity: 'follow' }> {
  return record.entity === 'follow';
}

function isChatRecord(record: SyncRecord): record is Extract<SyncRecord, { entity: 'chat' }> {
  return record.entity === 'chat';
}

function compareRecordsAscending(left: SyncRecord, right: SyncRecord): number {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt - right.updatedAt;
  }
  return left.id.localeCompare(right.id);
}

function createBatchFromRecords(
  peerId: PeerId,
  records: SyncRecord[],
  metadata: {
    version: 1 | 2;
    entity?: SyncEntity;
    itemIds?: string[];
    cursor?: string;
    nextCursor?: string;
    hasMore?: boolean;
  },
): IncrementalSyncBatch {
  return {
    version: metadata.version,
    peerId,
    entity: metadata.entity,
    itemIds: metadata.itemIds,
    cursor: metadata.cursor,
    nextCursor: metadata.nextCursor,
    hasMore: metadata.hasMore ?? false,
    posts: records.filter(isPostRecord).map((record) => record.data),
    profiles: records.filter(isProfileRecord).map((record) => record.data),
    comments: records.filter(isCommentRecord).map((record) => record.data),
    reactions: records.filter(isReactionRecord).map((record) => record.data),
    follows: records.filter(isFollowRecord).map((record) => record.data),
    chatMessages: records.filter(isChatRecord).map((record) => record.data),
  };
}

function toManifestItem(record: SyncRecord): SyncManifestItem {
  return {
    entity: record.entity,
    id: record.id,
    contentHash: record.contentHash,
    stateHash: record.stateHash,
    updatedAt: record.updatedAt,
    author: record.author,
    deleted: record.deleted,
  };
}

function hashManifestRecords(records: SyncRecord[]): string {
  return hashManifestItems(records.map(toManifestItem));
}

function hashManifestItems(items: readonly SyncManifestItem[]): string {
  return sha256Hex(
    items
      .map(
        (item) =>
          `${item.entity}:${encodeURIComponent(item.id)}:${item.updatedAt}:${item.stateHash}`,
      )
      .join('\n'),
  );
}

function filterRecordsAfterCursor(records: SyncRecord[], cursor?: string): SyncRecord[] {
  const decoded = decodeCursor(cursor);
  if (!decoded) {
    return records;
  }
  return records.filter(
    (record) =>
      record.updatedAt > decoded.updatedAt ||
      (record.updatedAt === decoded.updatedAt && record.id > decoded.id),
  );
}

async function listIncludingDeleted<T>(repository: {
  getAll(limit?: number, offset?: number): Promise<T[]>;
  getAllIncludingDeleted?: (limit?: number, offset?: number) => Promise<T[]>;
  getAllForSync?: () => Promise<T[]>;
}): Promise<T[]> {
  if (repository.getAllForSync) {
    return await repository.getAllForSync();
  }
  return repository.getAllIncludingDeleted
    ? await repository.getAllIncludingDeleted(1000, 0)
    : await repository.getAll(1000, 0);
}

async function listRepositoryRecords<T>(repository: {
  getAll(limit?: number, offset?: number): Promise<T[]>;
  getAllForSync?: () => Promise<T[]>;
}): Promise<T[]> {
  return repository.getAllForSync
    ? await repository.getAllForSync()
    : await repository.getAll(1000, 0);
}
