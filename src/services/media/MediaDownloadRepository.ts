import type { DatabaseService } from '@/database/DatabaseService';
import { AppError, toAppError } from '@/errors/AppError';
import type { PeerId } from '@/network/NetworkTypes';
import type { StorageService } from '@/services/storage/StorageService';
import { sha256Hex } from '@/utils/hash';

import {
  cloneMediaAvailabilityAnnouncement,
  isMediaAvailabilityAnnouncementV2,
  isMediaAvailabilityItem,
  isMediaQuarantineReason,
  isMediaReplicaObservationStatus,
  type LegacyMediaAvailabilityManifest,
  type MediaAvailabilityAnnouncementV2,
  type MediaAvailabilityItem,
  type MediaQuarantineReason,
  type MediaQuarantineRecord,
  type MediaReplicaObservation,
  type MediaReplicaObservationStatus,
} from './MediaAvailability';
import type { MediaDownloadState, MediaDownloadStatus } from './PeerMediaSyncService';

export const LEGACY_MEDIA_DOWNLOAD_STATES_KEY = 'media_download_states';
export const LEGACY_MEDIA_AVAILABILITY_KEY = 'media_availability_manifests';

const DOWNLOAD_TABLE = 'media_download_jobs';
const AVAILABILITY_TABLE = 'media_availability_announcements';
const REPLICA_OBSERVATION_TABLE = 'media_replica_observations';
const QUARANTINE_TABLE = 'media_quarantine_records';
const ACCESS_TABLE = 'media_access_records';
const DOWNLOAD_SCHEMA_VERSION = 1;
const LEGACY_AVAILABILITY_SCHEMA_VERSION = 1;
const SIGNED_AVAILABILITY_SCHEMA_VERSION = 2;
const REPLICA_OBSERVATION_SCHEMA_VERSION = 1;
const QUARANTINE_SCHEMA_VERSION = 1;
const ACCESS_SCHEMA_VERSION = 1;

export type MediaAvailabilityManifest = LegacyMediaAvailabilityManifest;
export type { MediaAvailabilityItem } from './MediaAvailability';

export interface MediaPersistenceMigrationResult {
  migratedDownloadJobs: number;
  migratedAvailabilityAnnouncements: number;
  legacyDataRemoved: boolean;
}

interface MediaDownloadJobRow {
  id: string;
  schemaVersion: number;
  status: string;
  totalChunks: number;
  downloadedChunks: number;
  requestedChunks: number;
  failedChunks: number;
  candidatePeers: string;
  error: string | null;
  updatedAt: number;
}

interface MediaAvailabilityRow {
  id: string;
  schemaVersion: number;
  peerId: string;
  items: string;
  updatedAt: number;
}

interface MediaReplicaObservationRow {
  id: string;
  schemaVersion: number;
  peerId: string;
  mediaObjectId: string;
  chunkId: string | null;
  status: string;
  successCount: number;
  failureCount: number;
  latencyMs: number | null;
  validUntil: number | null;
  updatedAt: number;
}

interface MediaQuarantineRow {
  id: string;
  schemaVersion: number;
  peerId: string;
  mediaObjectId: string;
  chunkId: string | null;
  reason: string;
  evidenceHash: string | null;
  failureCount: number;
  startedAt: number;
  expiresAt: number;
}

interface MediaAccessRow {
  id: string;
  schemaVersion: number;
  mediaObjectId: string;
  protected: number;
  lastAccessedAt: number;
  updatedAt: number;
}

export interface MediaAccessRecord {
  mediaObjectId: string;
  protected: boolean;
  lastAccessedAt: number;
  updatedAt: number;
}

export type SaveMediaAnnouncementResult = 'saved' | 'duplicate' | 'stale' | 'conflict';

export class MediaDownloadRepository {
  private readonly states = new Map<string, MediaDownloadState>();
  private readonly manifests = new Map<PeerId, MediaAvailabilityManifest>();
  private readonly announcements = new Map<string, MediaAvailabilityAnnouncementV2>();
  private readonly observations = new Map<string, MediaReplicaObservation>();
  private readonly quarantines = new Map<string, MediaQuarantineRecord>();
  private readonly accessRecords = new Map<string, MediaAccessRecord>();
  private initialization: Promise<MediaPersistenceMigrationResult> | null = null;
  private availabilityWriteQueue: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly legacyStorage?: StorageService,
  ) {}

  async initialize(): Promise<MediaPersistenceMigrationResult> {
    if (!this.initialization) {
      this.initialization = this.initializeRepository();
    }
    return await this.initialization;
  }

  listStates(): MediaDownloadState[] {
    this.assertInitialized();
    return [...this.states.values()]
      .map(cloneDownloadState)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  getState(mediaObjectId: string): MediaDownloadState | null {
    this.assertInitialized();
    const state = this.states.get(mediaObjectId);
    return state ? cloneDownloadState(state) : null;
  }

  async saveState(state: MediaDownloadState): Promise<void> {
    this.assertInitialized();
    const normalized = normalizeDownloadState(state);
    await this.writeState(normalized, this.database);
    this.states.set(normalized.mediaObjectId, cloneDownloadState(normalized));
  }

  async removeState(mediaObjectId: string): Promise<void> {
    this.assertInitialized();
    await this.database.run(`DELETE FROM ${DOWNLOAD_TABLE} WHERE id = ?;`, [mediaObjectId]);
    this.states.delete(mediaObjectId);
  }

  listManifests(): MediaAvailabilityManifest[] {
    this.assertInitialized();
    return [...this.manifests.values()]
      .map(cloneManifest)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  getManifest(peerId: PeerId): MediaAvailabilityManifest | null {
    this.assertInitialized();
    const manifest = this.manifests.get(peerId);
    return manifest ? cloneManifest(manifest) : null;
  }

  async saveManifest(manifest: MediaAvailabilityManifest): Promise<void> {
    this.assertInitialized();
    const normalized = normalizeManifest(manifest);
    await this.writeManifest(normalized, this.database);
    this.manifests.set(normalized.peerId, cloneManifest(normalized));
  }

  listAnnouncements(peerId?: PeerId): MediaAvailabilityAnnouncementV2[] {
    this.assertInitialized();
    return [...this.announcements.values()]
      .filter((announcement) => !peerId || announcement.peerId === peerId)
      .map(cloneMediaAvailabilityAnnouncement)
      .sort(
        (left, right) =>
          right.sequence - left.sequence ||
          left.pageIndex - right.pageIndex ||
          String(left.peerId).localeCompare(String(right.peerId)),
      );
  }

  getLatestAnnouncementSequence(peerId: PeerId): number {
    this.assertInitialized();
    return this.listAnnouncements(peerId).reduce(
      (latest, announcement) => Math.max(latest, announcement.sequence),
      0,
    );
  }

  async saveAnnouncement(
    announcement: MediaAvailabilityAnnouncementV2,
  ): Promise<SaveMediaAnnouncementResult> {
    this.assertInitialized();
    const normalized = cloneMediaAvailabilityAnnouncement(announcement);
    let result: SaveMediaAnnouncementResult = 'saved';
    const operation = this.availabilityWriteQueue.then(async () => {
      const peerAnnouncements = [...this.announcements.values()].filter(
        (item) => item.peerId === normalized.peerId,
      );
      const latestSequence = peerAnnouncements.reduce(
        (latest, item) => Math.max(latest, item.sequence),
        0,
      );
      if (normalized.sequence < latestSequence) {
        result = 'stale';
        return;
      }

      const announcementId = createAnnouncementId(normalized);
      const existing = this.announcements.get(announcementId);
      if (existing) {
        result =
          existing.signature === normalized.signature &&
          existing.expiresAt === normalized.expiresAt &&
          existing.pageCount === normalized.pageCount
            ? 'duplicate'
            : 'conflict';
        return;
      }

      const sameSequence = peerAnnouncements.filter(
        (item) => item.sequence === normalized.sequence,
      );
      if (
        sameSequence.some(
          (item) =>
            item.issuedAt !== normalized.issuedAt ||
            item.expiresAt !== normalized.expiresAt ||
            item.pageCount !== normalized.pageCount,
        )
      ) {
        result = 'conflict';
        return;
      }

      await this.database.transaction(async (transaction) => {
        if (normalized.sequence > latestSequence) {
          await transaction.run(`DELETE FROM ${AVAILABILITY_TABLE} WHERE peerId = ?;`, [
            normalized.peerId,
          ]);
        }
        await this.writeAnnouncement(normalized, transaction);
      });

      if (normalized.sequence > latestSequence) {
        for (const [id, item] of this.announcements.entries()) {
          if (item.peerId === normalized.peerId) {
            this.announcements.delete(id);
          }
        }
      }
      this.announcements.set(announcementId, cloneMediaAvailabilityAnnouncement(normalized));
    });
    this.availabilityWriteQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
    return result;
  }

  async removeAnnouncement(announcement: MediaAvailabilityAnnouncementV2): Promise<void> {
    this.assertInitialized();
    const id = createAnnouncementId(announcement);
    await this.database.run(`DELETE FROM ${AVAILABILITY_TABLE} WHERE id = ?;`, [id]);
    this.announcements.delete(id);
  }

  async pruneExpiredAnnouncements(now = Date.now()): Promise<number> {
    this.assertInitialized();
    const sequenceAnchors = new Set<string>();
    const announcementsByPeer = new Map<PeerId, MediaAvailabilityAnnouncementV2[]>();
    for (const announcement of this.announcements.values()) {
      const peerAnnouncements = announcementsByPeer.get(announcement.peerId) ?? [];
      peerAnnouncements.push(announcement);
      announcementsByPeer.set(announcement.peerId, peerAnnouncements);
    }
    for (const peerAnnouncements of announcementsByPeer.values()) {
      const latestSequence = peerAnnouncements.reduce(
        (latest, announcement) => Math.max(latest, announcement.sequence),
        0,
      );
      const anchor = peerAnnouncements
        .filter((announcement) => announcement.sequence === latestSequence)
        .sort((left, right) => left.pageIndex - right.pageIndex)[0];
      if (anchor) {
        sequenceAnchors.add(createAnnouncementId(anchor));
      }
    }
    const expired = [...this.announcements.entries()].filter(
      ([id, announcement]) => announcement.expiresAt <= now && !sequenceAnchors.has(id),
    );
    if (expired.length === 0) {
      return 0;
    }
    await this.database.transaction(async (transaction) => {
      for (const [id] of expired) {
        await transaction.run(`DELETE FROM ${AVAILABILITY_TABLE} WHERE id = ?;`, [id]);
      }
    });
    for (const [id] of expired) {
      this.announcements.delete(id);
    }
    return expired.length;
  }

  getReplicaObservation(
    peerId: PeerId,
    mediaObjectId: string,
    chunkId?: string,
  ): MediaReplicaObservation | null {
    this.assertInitialized();
    const observation = this.observations.get(
      createReplicaObservationId(peerId, mediaObjectId, chunkId),
    );
    return observation ? cloneObservation(observation) : null;
  }

  listReplicaObservations(): MediaReplicaObservation[] {
    this.assertInitialized();
    return [...this.observations.values()]
      .map(cloneObservation)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  }

  async recordReplicaResult(input: {
    peerId: PeerId;
    mediaObjectId: string;
    chunkId?: string;
    status: MediaReplicaObservationStatus;
    latencyMs?: number;
    validUntil?: number;
    now?: number;
  }): Promise<MediaReplicaObservation> {
    this.assertInitialized();
    const now = input.now ?? Date.now();
    const id = createReplicaObservationId(input.peerId, input.mediaObjectId, input.chunkId);
    const current = this.observations.get(id);
    const success = input.status === 'success';
    const observation: MediaReplicaObservation = {
      id,
      peerId: input.peerId,
      mediaObjectId: input.mediaObjectId,
      chunkId: input.chunkId,
      status: input.status,
      successCount: (current?.successCount ?? 0) + (success ? 1 : 0),
      failureCount: (current?.failureCount ?? 0) + (success ? 0 : 1),
      latencyMs: input.latencyMs ?? current?.latencyMs,
      validUntil: input.validUntil ?? current?.validUntil,
      updatedAt: now,
    };
    await this.writeReplicaObservation(observation, this.database);
    this.observations.set(id, cloneObservation(observation));
    return cloneObservation(observation);
  }

  listQuarantines(now?: number): MediaQuarantineRecord[] {
    this.assertInitialized();
    return [...this.quarantines.values()]
      .filter((record) => now === undefined || record.expiresAt > now)
      .map(cloneQuarantine)
      .sort((left, right) => right.startedAt - left.startedAt || left.id.localeCompare(right.id));
  }

  isReplicaQuarantined(
    peerId: PeerId,
    mediaObjectId: string,
    chunkId: string,
    now = Date.now(),
  ): boolean {
    this.assertInitialized();
    return [...this.quarantines.values()].some(
      (record) =>
        record.peerId === peerId &&
        record.mediaObjectId === mediaObjectId &&
        (record.chunkId === undefined || record.chunkId === chunkId) &&
        record.expiresAt > now,
    );
  }

  async quarantineReplica(input: {
    peerId: PeerId;
    mediaObjectId: string;
    chunkId?: string;
    reason: MediaQuarantineReason;
    evidenceHash?: string;
    durationMs: number;
    now?: number;
  }): Promise<MediaQuarantineRecord> {
    this.assertInitialized();
    const now = input.now ?? Date.now();
    const id = createQuarantineId(input.peerId, input.mediaObjectId, input.chunkId);
    const current = this.quarantines.get(id);
    const record: MediaQuarantineRecord = {
      id,
      peerId: input.peerId,
      mediaObjectId: input.mediaObjectId,
      chunkId: input.chunkId,
      reason: input.reason,
      evidenceHash: input.evidenceHash,
      failureCount: (current?.failureCount ?? 0) + 1,
      startedAt: current?.startedAt ?? now,
      expiresAt: Math.max(current?.expiresAt ?? 0, now + Math.max(1, input.durationMs)),
    };
    await this.writeQuarantine(record, this.database);
    this.quarantines.set(id, cloneQuarantine(record));
    return cloneQuarantine(record);
  }

  async pruneExpiredQuarantines(now = Date.now()): Promise<number> {
    this.assertInitialized();
    const expired = [...this.quarantines.entries()].filter(([, record]) => record.expiresAt <= now);
    if (expired.length === 0) {
      return 0;
    }
    await this.database.transaction(async (transaction) => {
      for (const [id] of expired) {
        await transaction.run(`DELETE FROM ${QUARANTINE_TABLE} WHERE id = ?;`, [id]);
      }
    });
    for (const [id] of expired) {
      this.quarantines.delete(id);
    }
    return expired.length;
  }

  getMediaAccess(mediaObjectId: string): MediaAccessRecord | null {
    this.assertInitialized();
    const record = this.accessRecords.get(mediaObjectId);
    return record ? cloneAccessRecord(record) : null;
  }

  listMediaAccess(): MediaAccessRecord[] {
    this.assertInitialized();
    return [...this.accessRecords.values()]
      .map(cloneAccessRecord)
      .sort(
        (left, right) =>
          right.lastAccessedAt - left.lastAccessedAt ||
          left.mediaObjectId.localeCompare(right.mediaObjectId),
      );
  }

  async touchMediaAccess(mediaObjectId: string, now = Date.now()): Promise<MediaAccessRecord> {
    this.assertInitialized();
    const current = this.accessRecords.get(mediaObjectId);
    const record: MediaAccessRecord = {
      mediaObjectId,
      protected: current?.protected ?? false,
      lastAccessedAt: Math.max(current?.lastAccessedAt ?? 0, now),
      updatedAt: Math.max(current?.updatedAt ?? 0, now),
    };
    await this.writeAccessRecord(record, this.database);
    this.accessRecords.set(mediaObjectId, cloneAccessRecord(record));
    return cloneAccessRecord(record);
  }

  async setMediaProtected(
    mediaObjectId: string,
    protectedValue: boolean,
    now = Date.now(),
  ): Promise<MediaAccessRecord> {
    this.assertInitialized();
    const current = this.accessRecords.get(mediaObjectId);
    const record: MediaAccessRecord = {
      mediaObjectId,
      protected: protectedValue,
      lastAccessedAt: current?.lastAccessedAt ?? now,
      updatedAt: Math.max(current?.updatedAt ?? 0, now),
    };
    await this.writeAccessRecord(record, this.database);
    this.accessRecords.set(mediaObjectId, cloneAccessRecord(record));
    return cloneAccessRecord(record);
  }

  async removeMediaAccess(mediaObjectId: string): Promise<void> {
    this.assertInitialized();
    await this.database.run(`DELETE FROM ${ACCESS_TABLE} WHERE id = ?;`, [mediaObjectId]);
    this.accessRecords.delete(mediaObjectId);
  }

  async recordChunkAvailability(
    peerId: PeerId,
    mediaObjectId: string,
    chunkId: string,
  ): Promise<void> {
    this.assertInitialized();
    const now = Date.now();
    const current = this.manifests.get(peerId) ?? { peerId, items: [], updatedAt: now };
    const existingItem = current.items.find((item) => item.mediaObjectId === mediaObjectId);
    const nextChunks = existingItem
      ? Array.from(new Set([...existingItem.chunks, chunkId]))
      : [chunkId];
    const nextItem: MediaAvailabilityItem = {
      mediaObjectId,
      chunks: nextChunks,
      totalChunks: Math.max(existingItem?.totalChunks ?? 0, nextChunks.length),
      updatedAt: now,
    };

    await this.saveManifest({
      peerId,
      items: [...current.items.filter((item) => item.mediaObjectId !== mediaObjectId), nextItem],
      updatedAt: now,
    });
  }

  findPeersForMedia(mediaObjectId: string, now = Date.now()): PeerId[] {
    this.assertInitialized();
    return Array.from(
      new Set(
        [...this.announcements.values()]
          .filter(
            (announcement) =>
              announcement.expiresAt > now &&
              announcement.items.some((item) => item.mediaObjectId === mediaObjectId),
          )
          .map((announcement) => announcement.peerId),
      ),
    ).sort((left, right) => String(left).localeCompare(String(right)));
  }

  findCompleteReplicaPeers(
    mediaObjectId: string,
    expectedChunkIds: readonly string[],
    now = Date.now(),
  ): PeerId[] {
    this.assertInitialized();
    if (expectedChunkIds.length === 0) {
      return [];
    }
    const expectedChunks = new Set(expectedChunkIds);
    const announcementsByPeer = new Map<PeerId, MediaAvailabilityAnnouncementV2[]>();
    for (const announcement of this.announcements.values()) {
      if (announcement.expiresAt <= now) {
        continue;
      }
      const existing = announcementsByPeer.get(announcement.peerId) ?? [];
      existing.push(announcement);
      announcementsByPeer.set(announcement.peerId, existing);
    }

    const completePeers: PeerId[] = [];
    for (const [peerId, peerAnnouncements] of announcementsByPeer.entries()) {
      const latestSequence = peerAnnouncements.reduce(
        (latest, announcement) => Math.max(latest, announcement.sequence),
        0,
      );
      const pages = peerAnnouncements
        .filter((announcement) => announcement.sequence === latestSequence)
        .sort((left, right) => left.pageIndex - right.pageIndex);
      const firstPage = pages[0];
      if (
        !firstPage ||
        pages.length !== firstPage.pageCount ||
        pages.some(
          (page, index) =>
            page.pageIndex !== index ||
            page.pageCount !== firstPage.pageCount ||
            page.issuedAt !== firstPage.issuedAt ||
            page.expiresAt !== firstPage.expiresAt,
        )
      ) {
        continue;
      }

      const advertisedChunks = new Set<string>();
      let totalChunks: number | null = null;
      let inconsistent = false;
      for (const page of pages) {
        for (const item of page.items) {
          if (item.mediaObjectId !== mediaObjectId) {
            continue;
          }
          if (totalChunks !== null && totalChunks !== item.totalChunks) {
            inconsistent = true;
            break;
          }
          totalChunks = item.totalChunks;
          item.chunks.forEach((chunkId) => advertisedChunks.add(chunkId));
        }
        if (inconsistent) {
          break;
        }
      }

      if (
        !inconsistent &&
        totalChunks === expectedChunks.size &&
        advertisedChunks.size === expectedChunks.size &&
        [...expectedChunks].every((chunkId) => advertisedChunks.has(chunkId))
      ) {
        completePeers.push(peerId);
      }
    }

    return completePeers.sort((left, right) => String(left).localeCompare(String(right)));
  }

  findPeersForChunk(mediaObjectId: string, chunkId: string, now = Date.now()): PeerId[] {
    this.assertInitialized();
    return Array.from(
      new Set(
        [...this.announcements.values()]
          .filter(
            (announcement) =>
              announcement.expiresAt > now &&
              announcement.items.some(
                (item) => item.mediaObjectId === mediaObjectId && item.chunks.includes(chunkId),
              ),
          )
          .map((announcement) => announcement.peerId),
      ),
    ).sort((left, right) => String(left).localeCompare(String(right)));
  }

  async clear(): Promise<void> {
    this.assertInitialized();
    await this.database.transaction(async (transaction) => {
      await transaction.run(`DELETE FROM ${DOWNLOAD_TABLE};`);
      await transaction.run(`DELETE FROM ${AVAILABILITY_TABLE};`);
      await transaction.run(`DELETE FROM ${REPLICA_OBSERVATION_TABLE};`);
      await transaction.run(`DELETE FROM ${QUARANTINE_TABLE};`);
      await transaction.run(`DELETE FROM ${ACCESS_TABLE};`);
    });
    this.states.clear();
    this.manifests.clear();
    this.announcements.clear();
    this.observations.clear();
    this.quarantines.clear();
    this.accessRecords.clear();
  }

  private async initializeRepository(): Promise<MediaPersistenceMigrationResult> {
    try {
      await this.initializeTables();
      const migration = await this.migrateLegacyStorage();
      await this.loadPersistedData();
      this.initialized = true;
      return migration;
    } catch (error) {
      this.initialization = null;
      throw toAppError(error, {
        code: 'STORAGE_ERROR',
        message: 'Failed to initialize media persistence',
        safeMessage: 'Nao foi possivel preparar os downloads de midia locais.',
        severity: 'error',
        retryable: true,
        context: {
          scope: 'media.persistence',
          operation: 'initialize',
        },
      });
    }
  }

  private async initializeTables(): Promise<void> {
    await this.database.execute(`
      CREATE TABLE IF NOT EXISTS ${DOWNLOAD_TABLE} (
        id TEXT PRIMARY KEY,
        schemaVersion INTEGER NOT NULL,
        status TEXT NOT NULL,
        totalChunks INTEGER NOT NULL,
        downloadedChunks INTEGER NOT NULL,
        requestedChunks INTEGER NOT NULL,
        failedChunks INTEGER NOT NULL,
        candidatePeers TEXT NOT NULL,
        error TEXT,
        updatedAt INTEGER NOT NULL
      );
    `);
    await this.database.execute(
      `CREATE INDEX IF NOT EXISTS idx_media_download_status ON ${DOWNLOAD_TABLE}(status);`,
    );
    await this.database.execute(
      `CREATE INDEX IF NOT EXISTS idx_media_download_updated ON ${DOWNLOAD_TABLE}(updatedAt);`,
    );
    await this.database.execute(`
      CREATE TABLE IF NOT EXISTS ${AVAILABILITY_TABLE} (
        id TEXT PRIMARY KEY,
        schemaVersion INTEGER NOT NULL,
        peerId TEXT NOT NULL,
        items TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);
    await this.database.execute(
      `CREATE INDEX IF NOT EXISTS idx_media_availability_peer ON ${AVAILABILITY_TABLE}(peerId);`,
    );
    await this.database.execute(
      `CREATE INDEX IF NOT EXISTS idx_media_availability_updated ON ${AVAILABILITY_TABLE}(updatedAt);`,
    );
    await this.database.execute(`
      CREATE TABLE IF NOT EXISTS media_replica_observations (
        id TEXT PRIMARY KEY,
        schemaVersion INTEGER NOT NULL,
        peerId TEXT NOT NULL,
        mediaObjectId TEXT NOT NULL,
        chunkId TEXT,
        status TEXT NOT NULL,
        successCount INTEGER NOT NULL,
        failureCount INTEGER NOT NULL,
        latencyMs INTEGER,
        validUntil INTEGER,
        updatedAt INTEGER NOT NULL
      );
    `);
    await this.database.execute(
      'CREATE INDEX IF NOT EXISTS idx_media_replica_peer ON media_replica_observations(peerId);',
    );
    await this.database.execute(
      'CREATE INDEX IF NOT EXISTS idx_media_replica_object ON media_replica_observations(mediaObjectId);',
    );
    await this.database.execute(`
      CREATE TABLE IF NOT EXISTS media_quarantine_records (
        id TEXT PRIMARY KEY,
        schemaVersion INTEGER NOT NULL,
        peerId TEXT NOT NULL,
        mediaObjectId TEXT NOT NULL,
        chunkId TEXT,
        reason TEXT NOT NULL,
        evidenceHash TEXT,
        failureCount INTEGER NOT NULL,
        startedAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL
      );
    `);
    await this.database.execute(
      'CREATE INDEX IF NOT EXISTS idx_media_quarantine_peer ON media_quarantine_records(peerId);',
    );
    await this.database.execute(
      'CREATE INDEX IF NOT EXISTS idx_media_quarantine_expiry ON media_quarantine_records(expiresAt);',
    );
    await this.database.execute(`
      CREATE TABLE IF NOT EXISTS media_access_records (
        id TEXT PRIMARY KEY,
        schemaVersion INTEGER NOT NULL,
        mediaObjectId TEXT NOT NULL,
        protected INTEGER NOT NULL,
        lastAccessedAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);
    await this.database.execute(
      'CREATE INDEX IF NOT EXISTS idx_media_access_last_accessed ON media_access_records(lastAccessedAt);',
    );
  }

  private async migrateLegacyStorage(): Promise<MediaPersistenceMigrationResult> {
    if (!this.legacyStorage) {
      return {
        migratedDownloadJobs: 0,
        migratedAvailabilityAnnouncements: 0,
        legacyDataRemoved: false,
      };
    }

    const legacyStates = readLegacyDownloadStates(this.legacyStorage);
    const legacyManifests = readLegacyManifests(this.legacyStorage);
    const stateRows = await this.readStateRows();
    const manifestRows = await this.readManifestRows();
    const currentStates = new Map(
      stateRows.map((row) => {
        const state = mapDownloadStateRow(row);
        return [state.mediaObjectId, state];
      }),
    );
    const currentManifests = new Map(
      manifestRows
        .map(mapAvailabilityRow)
        .filter(
          (
            record,
          ): record is {
            kind: 'legacy';
            manifest: MediaAvailabilityManifest;
          } => record.kind === 'legacy',
        )
        .map(({ manifest }) => [manifest.peerId, manifest]),
    );
    let migratedDownloadJobs = 0;
    let migratedAvailabilityAnnouncements = 0;

    await this.database.transaction(async (transaction) => {
      for (const state of legacyStates) {
        const current = currentStates.get(state.mediaObjectId);
        if (current && current.updatedAt >= state.updatedAt) {
          continue;
        }
        await this.writeState(state, transaction);
        migratedDownloadJobs += 1;
      }
      for (const manifest of legacyManifests) {
        const current = currentManifests.get(manifest.peerId);
        if (current && current.updatedAt >= manifest.updatedAt) {
          continue;
        }
        await this.writeManifest(manifest, transaction);
        migratedAvailabilityAnnouncements += 1;
      }
    });

    const hadLegacyData =
      this.legacyStorage.getString(LEGACY_MEDIA_DOWNLOAD_STATES_KEY) !== null ||
      this.legacyStorage.getString(LEGACY_MEDIA_AVAILABILITY_KEY) !== null;
    if (hadLegacyData) {
      this.legacyStorage.remove(LEGACY_MEDIA_DOWNLOAD_STATES_KEY);
      this.legacyStorage.remove(LEGACY_MEDIA_AVAILABILITY_KEY);
    }

    return {
      migratedDownloadJobs,
      migratedAvailabilityAnnouncements,
      legacyDataRemoved: hadLegacyData,
    };
  }

  private async loadPersistedData(): Promise<void> {
    const states = (await this.readStateRows()).map(mapDownloadStateRow);
    const availabilityRecords = (await this.readManifestRows()).map(mapAvailabilityRow);
    const observations = (await this.readReplicaObservationRows()).map(mapReplicaObservationRow);
    const quarantines = (await this.readQuarantineRows()).map(mapQuarantineRow);
    const accessRecords = (await this.readAccessRows()).map(mapAccessRow);
    this.states.clear();
    this.manifests.clear();
    this.announcements.clear();
    this.observations.clear();
    this.quarantines.clear();
    this.accessRecords.clear();
    for (const state of states) {
      this.states.set(state.mediaObjectId, cloneDownloadState(state));
    }
    for (const record of availabilityRecords) {
      if (record.kind === 'legacy') {
        this.manifests.set(record.manifest.peerId, cloneManifest(record.manifest));
      } else {
        this.announcements.set(
          createAnnouncementId(record.announcement),
          cloneMediaAvailabilityAnnouncement(record.announcement),
        );
      }
    }
    for (const observation of observations) {
      this.observations.set(observation.id, cloneObservation(observation));
    }
    for (const quarantine of quarantines) {
      this.quarantines.set(quarantine.id, cloneQuarantine(quarantine));
    }
    for (const accessRecord of accessRecords) {
      this.accessRecords.set(accessRecord.mediaObjectId, cloneAccessRecord(accessRecord));
    }
  }

  private async readStateRows(): Promise<MediaDownloadJobRow[]> {
    const rows = await this.database.query(`SELECT * FROM ${DOWNLOAD_TABLE};`);
    return rows.map(assertDownloadJobRow);
  }

  private async readManifestRows(): Promise<MediaAvailabilityRow[]> {
    const rows = await this.database.query(`SELECT * FROM ${AVAILABILITY_TABLE};`);
    return rows.map(assertAvailabilityRow);
  }

  private async readReplicaObservationRows(): Promise<MediaReplicaObservationRow[]> {
    const rows = await this.database.query(`SELECT * FROM ${REPLICA_OBSERVATION_TABLE};`);
    return rows.map(assertReplicaObservationRow);
  }

  private async readQuarantineRows(): Promise<MediaQuarantineRow[]> {
    const rows = await this.database.query(`SELECT * FROM ${QUARANTINE_TABLE};`);
    return rows.map(assertQuarantineRow);
  }

  private async readAccessRows(): Promise<MediaAccessRow[]> {
    const rows = await this.database.query(`SELECT * FROM ${ACCESS_TABLE};`);
    return rows.map(assertAccessRow);
  }

  private async writeState(state: MediaDownloadState, database: DatabaseService): Promise<void> {
    await database.run(
      `
      INSERT OR REPLACE INTO ${DOWNLOAD_TABLE}
      (id, schemaVersion, status, totalChunks, downloadedChunks, requestedChunks, failedChunks, candidatePeers, error, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      [
        state.mediaObjectId,
        DOWNLOAD_SCHEMA_VERSION,
        state.status,
        state.totalChunks,
        state.downloadedChunks,
        state.requestedChunks,
        state.failedChunks,
        JSON.stringify(state.candidatePeers),
        state.error ?? null,
        state.updatedAt,
      ],
    );
  }

  private async writeManifest(
    manifest: MediaAvailabilityManifest,
    database: DatabaseService,
  ): Promise<void> {
    await database.run(
      `
      INSERT OR REPLACE INTO ${AVAILABILITY_TABLE}
      (id, schemaVersion, peerId, items, updatedAt)
      VALUES (?, ?, ?, ?, ?);
      `,
      [
        manifest.peerId,
        LEGACY_AVAILABILITY_SCHEMA_VERSION,
        manifest.peerId,
        JSON.stringify(manifest.items),
        manifest.updatedAt,
      ],
    );
  }

  private async writeAnnouncement(
    announcement: MediaAvailabilityAnnouncementV2,
    database: DatabaseService,
  ): Promise<void> {
    await database.run(
      `
      INSERT OR REPLACE INTO ${AVAILABILITY_TABLE}
      (id, schemaVersion, peerId, items, updatedAt)
      VALUES (?, ?, ?, ?, ?);
      `,
      [
        createAnnouncementId(announcement),
        SIGNED_AVAILABILITY_SCHEMA_VERSION,
        announcement.peerId,
        JSON.stringify(announcement),
        announcement.issuedAt,
      ],
    );
  }

  private async writeReplicaObservation(
    observation: MediaReplicaObservation,
    database: DatabaseService,
  ): Promise<void> {
    await database.run(
      `
      INSERT OR REPLACE INTO ${REPLICA_OBSERVATION_TABLE}
      (id, schemaVersion, peerId, mediaObjectId, chunkId, status, successCount, failureCount, latencyMs, validUntil, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      [
        observation.id,
        REPLICA_OBSERVATION_SCHEMA_VERSION,
        observation.peerId,
        observation.mediaObjectId,
        observation.chunkId ?? null,
        observation.status,
        observation.successCount,
        observation.failureCount,
        observation.latencyMs ?? null,
        observation.validUntil ?? null,
        observation.updatedAt,
      ],
    );
  }

  private async writeQuarantine(
    record: MediaQuarantineRecord,
    database: DatabaseService,
  ): Promise<void> {
    await database.run(
      `
      INSERT OR REPLACE INTO ${QUARANTINE_TABLE}
      (id, schemaVersion, peerId, mediaObjectId, chunkId, reason, evidenceHash, failureCount, startedAt, expiresAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      [
        record.id,
        QUARANTINE_SCHEMA_VERSION,
        record.peerId,
        record.mediaObjectId,
        record.chunkId ?? null,
        record.reason,
        record.evidenceHash ?? null,
        record.failureCount,
        record.startedAt,
        record.expiresAt,
      ],
    );
  }

  private async writeAccessRecord(
    record: MediaAccessRecord,
    database: DatabaseService,
  ): Promise<void> {
    await database.run(
      `
      INSERT OR REPLACE INTO ${ACCESS_TABLE}
      (id, schemaVersion, mediaObjectId, protected, lastAccessedAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?);
      `,
      [
        record.mediaObjectId,
        ACCESS_SCHEMA_VERSION,
        record.mediaObjectId,
        record.protected ? 1 : 0,
        record.lastAccessedAt,
        record.updatedAt,
      ],
    );
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new AppError({
        code: 'STORAGE_ERROR',
        message: 'Media persistence repository is not initialized',
        safeMessage: 'O armazenamento de midia ainda nao esta pronto.',
        severity: 'error',
        retryable: true,
        context: {
          scope: 'media.persistence',
          operation: 'assert-initialized',
        },
      });
    }
  }
}

function readLegacyDownloadStates(storage: StorageService): MediaDownloadState[] {
  const value = parseLegacyJson(storage, LEGACY_MEDIA_DOWNLOAD_STATES_KEY);
  if (value === null) {
    return [];
  }
  if (!isRecord(value)) {
    throw corruptLegacyError(LEGACY_MEDIA_DOWNLOAD_STATES_KEY);
  }

  const states: MediaDownloadState[] = [];
  for (const [mediaObjectId, state] of Object.entries(value)) {
    if (!isMediaDownloadState(state) || state.mediaObjectId !== mediaObjectId) {
      throw corruptLegacyError(LEGACY_MEDIA_DOWNLOAD_STATES_KEY);
    }
    states.push(normalizeDownloadState(state));
  }
  return states;
}

function readLegacyManifests(storage: StorageService): MediaAvailabilityManifest[] {
  const value = parseLegacyJson(storage, LEGACY_MEDIA_AVAILABILITY_KEY);
  if (value === null) {
    return [];
  }
  if (!isRecord(value)) {
    throw corruptLegacyError(LEGACY_MEDIA_AVAILABILITY_KEY);
  }

  const manifests: MediaAvailabilityManifest[] = [];
  for (const [peerId, manifest] of Object.entries(value)) {
    if (!isMediaAvailabilityManifest(manifest) || manifest.peerId !== peerId) {
      throw corruptLegacyError(LEGACY_MEDIA_AVAILABILITY_KEY);
    }
    manifests.push(normalizeManifest(manifest));
  }
  return manifests;
}

function parseLegacyJson(storage: StorageService, key: string): unknown {
  const raw = storage.getString(key);
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new AppError({
      code: 'STORAGE_ERROR',
      message: `Legacy media record ${key} is not valid JSON`,
      safeMessage: 'Um registro antigo de midia esta corrompido.',
      severity: 'error',
      retryable: false,
      context: {
        scope: 'media.persistence',
        operation: 'migrate',
        key,
      },
      cause: error,
    });
  }
}

function mapDownloadStateRow(row: MediaDownloadJobRow): MediaDownloadState {
  let candidatePeers: unknown;
  try {
    candidatePeers = JSON.parse(row.candidatePeers);
  } catch {
    throw corruptRowError(DOWNLOAD_TABLE, row.id);
  }
  const state: unknown = {
    mediaObjectId: row.id,
    status: row.status,
    totalChunks: row.totalChunks,
    downloadedChunks: row.downloadedChunks,
    requestedChunks: row.requestedChunks,
    failedChunks: row.failedChunks,
    candidatePeers,
    error: row.error ?? undefined,
    updatedAt: row.updatedAt,
  };
  if (!isMediaDownloadState(state)) {
    throw corruptRowError(DOWNLOAD_TABLE, row.id);
  }
  return normalizeDownloadState(state);
}

type StoredAvailabilityRecord =
  | { kind: 'legacy'; manifest: MediaAvailabilityManifest }
  | { kind: 'signed'; announcement: MediaAvailabilityAnnouncementV2 };

function mapAvailabilityRow(row: MediaAvailabilityRow): StoredAvailabilityRecord {
  let payload: unknown;
  try {
    payload = JSON.parse(row.items);
  } catch {
    throw corruptRowError(AVAILABILITY_TABLE, row.id);
  }

  if (row.schemaVersion === LEGACY_AVAILABILITY_SCHEMA_VERSION) {
    const manifest: unknown = {
      peerId: row.peerId,
      items: payload,
      updatedAt: row.updatedAt,
    };
    if (!isMediaAvailabilityManifest(manifest) || manifest.peerId !== row.id) {
      throw corruptRowError(AVAILABILITY_TABLE, row.id);
    }
    return { kind: 'legacy', manifest: normalizeManifest(manifest) };
  }

  if (
    row.schemaVersion !== SIGNED_AVAILABILITY_SCHEMA_VERSION ||
    !isMediaAvailabilityAnnouncementV2(payload) ||
    payload.peerId !== row.peerId ||
    createAnnouncementId(payload) !== row.id ||
    payload.issuedAt !== row.updatedAt
  ) {
    throw corruptRowError(AVAILABILITY_TABLE, row.id);
  }
  return { kind: 'signed', announcement: cloneMediaAvailabilityAnnouncement(payload) };
}

function mapReplicaObservationRow(row: MediaReplicaObservationRow): MediaReplicaObservation {
  return {
    id: row.id,
    peerId: row.peerId as PeerId,
    mediaObjectId: row.mediaObjectId,
    chunkId: row.chunkId ?? undefined,
    status: row.status as MediaReplicaObservationStatus,
    successCount: row.successCount,
    failureCount: row.failureCount,
    latencyMs: row.latencyMs ?? undefined,
    validUntil: row.validUntil ?? undefined,
    updatedAt: row.updatedAt,
  };
}

function mapQuarantineRow(row: MediaQuarantineRow): MediaQuarantineRecord {
  return {
    id: row.id,
    peerId: row.peerId as PeerId,
    mediaObjectId: row.mediaObjectId,
    chunkId: row.chunkId ?? undefined,
    reason: row.reason as MediaQuarantineReason,
    evidenceHash: row.evidenceHash ?? undefined,
    failureCount: row.failureCount,
    startedAt: row.startedAt,
    expiresAt: row.expiresAt,
  };
}

function mapAccessRow(row: MediaAccessRow): MediaAccessRecord {
  return {
    mediaObjectId: row.mediaObjectId,
    protected: row.protected === 1,
    lastAccessedAt: row.lastAccessedAt,
    updatedAt: row.updatedAt,
  };
}

function assertDownloadJobRow(value: unknown): MediaDownloadJobRow {
  if (!isRecord(value)) {
    throw corruptRowError(DOWNLOAD_TABLE, 'unknown');
  }
  if (
    typeof value.id !== 'string' ||
    value.schemaVersion !== DOWNLOAD_SCHEMA_VERSION ||
    typeof value.status !== 'string' ||
    !isNonNegativeInteger(value.totalChunks) ||
    !isNonNegativeInteger(value.downloadedChunks) ||
    !isNonNegativeInteger(value.requestedChunks) ||
    !isNonNegativeInteger(value.failedChunks) ||
    typeof value.candidatePeers !== 'string' ||
    !isOptionalString(value.error) ||
    !isTimestamp(value.updatedAt)
  ) {
    throw corruptRowError(DOWNLOAD_TABLE, typeof value.id === 'string' ? value.id : 'unknown');
  }
  return {
    id: value.id,
    schemaVersion: value.schemaVersion,
    status: value.status,
    totalChunks: value.totalChunks,
    downloadedChunks: value.downloadedChunks,
    requestedChunks: value.requestedChunks,
    failedChunks: value.failedChunks,
    candidatePeers: value.candidatePeers,
    error: value.error ?? null,
    updatedAt: value.updatedAt,
  };
}

function assertAvailabilityRow(value: unknown): MediaAvailabilityRow {
  if (!isRecord(value)) {
    throw corruptRowError(AVAILABILITY_TABLE, 'unknown');
  }
  if (
    typeof value.id !== 'string' ||
    (value.schemaVersion !== LEGACY_AVAILABILITY_SCHEMA_VERSION &&
      value.schemaVersion !== SIGNED_AVAILABILITY_SCHEMA_VERSION) ||
    typeof value.peerId !== 'string' ||
    typeof value.items !== 'string' ||
    !isTimestamp(value.updatedAt)
  ) {
    throw corruptRowError(AVAILABILITY_TABLE, typeof value.id === 'string' ? value.id : 'unknown');
  }
  return {
    id: value.id,
    schemaVersion: value.schemaVersion,
    peerId: value.peerId,
    items: value.items,
    updatedAt: value.updatedAt,
  };
}

function assertReplicaObservationRow(value: unknown): MediaReplicaObservationRow {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.schemaVersion !== REPLICA_OBSERVATION_SCHEMA_VERSION ||
    typeof value.peerId !== 'string' ||
    typeof value.mediaObjectId !== 'string' ||
    !isOptionalString(value.chunkId) ||
    !isMediaReplicaObservationStatus(value.status) ||
    !isNonNegativeInteger(value.successCount) ||
    !isNonNegativeInteger(value.failureCount) ||
    (value.latencyMs !== null &&
      value.latencyMs !== undefined &&
      !isNonNegativeInteger(value.latencyMs)) ||
    (value.validUntil !== null &&
      value.validUntil !== undefined &&
      !isTimestamp(value.validUntil)) ||
    !isTimestamp(value.updatedAt)
  ) {
    throw corruptRowError(
      REPLICA_OBSERVATION_TABLE,
      isRecord(value) && typeof value.id === 'string' ? value.id : 'unknown',
    );
  }
  return {
    id: value.id,
    schemaVersion: value.schemaVersion,
    peerId: value.peerId,
    mediaObjectId: value.mediaObjectId,
    chunkId: value.chunkId ?? null,
    status: value.status,
    successCount: value.successCount,
    failureCount: value.failureCount,
    latencyMs: value.latencyMs ?? null,
    validUntil: value.validUntil ?? null,
    updatedAt: value.updatedAt,
  };
}

function assertQuarantineRow(value: unknown): MediaQuarantineRow {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.schemaVersion !== QUARANTINE_SCHEMA_VERSION ||
    typeof value.peerId !== 'string' ||
    typeof value.mediaObjectId !== 'string' ||
    !isOptionalString(value.chunkId) ||
    !isMediaQuarantineReason(value.reason) ||
    !isOptionalString(value.evidenceHash) ||
    !isNonNegativeInteger(value.failureCount) ||
    value.failureCount === 0 ||
    !isTimestamp(value.startedAt) ||
    !isTimestamp(value.expiresAt) ||
    value.expiresAt <= value.startedAt
  ) {
    throw corruptRowError(
      QUARANTINE_TABLE,
      isRecord(value) && typeof value.id === 'string' ? value.id : 'unknown',
    );
  }
  return {
    id: value.id,
    schemaVersion: value.schemaVersion,
    peerId: value.peerId,
    mediaObjectId: value.mediaObjectId,
    chunkId: value.chunkId ?? null,
    reason: value.reason,
    evidenceHash: value.evidenceHash ?? null,
    failureCount: value.failureCount,
    startedAt: value.startedAt,
    expiresAt: value.expiresAt,
  };
}

function assertAccessRow(value: unknown): MediaAccessRow {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.schemaVersion !== ACCESS_SCHEMA_VERSION ||
    typeof value.mediaObjectId !== 'string' ||
    value.id !== value.mediaObjectId ||
    (value.protected !== 0 && value.protected !== 1) ||
    !isTimestamp(value.lastAccessedAt) ||
    !isTimestamp(value.updatedAt)
  ) {
    throw corruptRowError(
      ACCESS_TABLE,
      isRecord(value) && typeof value.id === 'string' ? value.id : 'unknown',
    );
  }
  return {
    id: value.id,
    schemaVersion: value.schemaVersion,
    mediaObjectId: value.mediaObjectId,
    protected: value.protected,
    lastAccessedAt: value.lastAccessedAt,
    updatedAt: value.updatedAt,
  };
}

function normalizeDownloadState(state: MediaDownloadState): MediaDownloadState {
  return {
    ...state,
    totalChunks: Math.max(0, Math.floor(state.totalChunks)),
    downloadedChunks: Math.max(0, Math.floor(state.downloadedChunks)),
    requestedChunks: Math.max(0, Math.floor(state.requestedChunks)),
    failedChunks: Math.max(0, Math.floor(state.failedChunks)),
    candidatePeers: Array.from(new Set(state.candidatePeers)),
  };
}

function cloneDownloadState(state: MediaDownloadState): MediaDownloadState {
  return {
    ...state,
    candidatePeers: [...state.candidatePeers],
  };
}

function normalizeManifest(manifest: MediaAvailabilityManifest): MediaAvailabilityManifest {
  return {
    peerId: manifest.peerId,
    items: manifest.items.filter(isMediaAvailabilityItem).map((item) => ({
      mediaObjectId: item.mediaObjectId,
      chunks: Array.from(new Set(item.chunks)),
      totalChunks: Math.max(item.totalChunks, item.chunks.length),
      updatedAt: item.updatedAt,
    })),
    updatedAt: manifest.updatedAt,
  };
}

function cloneManifest(manifest: MediaAvailabilityManifest): MediaAvailabilityManifest {
  return {
    ...manifest,
    items: manifest.items.map((item) => ({
      ...item,
      chunks: [...item.chunks],
    })),
  };
}

function isMediaDownloadState(value: unknown): value is MediaDownloadState {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.mediaObjectId === 'string' &&
    isDownloadStatus(value.status) &&
    isNonNegativeInteger(value.totalChunks) &&
    isNonNegativeInteger(value.downloadedChunks) &&
    isNonNegativeInteger(value.requestedChunks) &&
    isNonNegativeInteger(value.failedChunks) &&
    Array.isArray(value.candidatePeers) &&
    value.candidatePeers.every((peerId) => typeof peerId === 'string') &&
    isTimestamp(value.updatedAt) &&
    (value.error === undefined || typeof value.error === 'string')
  );
}

function isDownloadStatus(value: unknown): value is MediaDownloadStatus {
  return (
    value === 'idle' ||
    value === 'queued' ||
    value === 'downloading' ||
    value === 'partial' ||
    value === 'available' ||
    value === 'failed' ||
    value === 'cancelled'
  );
}

function isMediaAvailabilityManifest(value: unknown): value is MediaAvailabilityManifest {
  return (
    isRecord(value) &&
    typeof value.peerId === 'string' &&
    Array.isArray(value.items) &&
    value.items.every(isMediaAvailabilityItem) &&
    isTimestamp(value.updatedAt)
  );
}

function createAnnouncementId(announcement: MediaAvailabilityAnnouncementV2): string {
  return `media_availability_${sha256Hex(
    JSON.stringify([announcement.peerId, announcement.sequence, announcement.pageIndex]),
  )}`;
}

function createReplicaObservationId(
  peerId: PeerId,
  mediaObjectId: string,
  chunkId?: string,
): string {
  return `media_replica_${sha256Hex(JSON.stringify([peerId, mediaObjectId, chunkId ?? null]))}`;
}

function createQuarantineId(peerId: PeerId, mediaObjectId: string, chunkId?: string): string {
  return `media_quarantine_${sha256Hex(JSON.stringify([peerId, mediaObjectId, chunkId ?? null]))}`;
}

function cloneObservation(observation: MediaReplicaObservation): MediaReplicaObservation {
  return { ...observation };
}

function cloneQuarantine(record: MediaQuarantineRecord): MediaQuarantineRecord {
  return { ...record };
}

function cloneAccessRecord(record: MediaAccessRecord): MediaAccessRecord {
  return { ...record };
}

function corruptLegacyError(key: string): AppError {
  return new AppError({
    code: 'STORAGE_ERROR',
    message: `Legacy media record ${key} is corrupt`,
    safeMessage: 'Um registro antigo de midia esta corrompido.',
    severity: 'error',
    retryable: false,
    context: {
      scope: 'media.persistence',
      operation: 'migrate',
      key,
    },
  });
}

function corruptRowError(table: string, id: string): AppError {
  return new AppError({
    code: 'STORAGE_ERROR',
    message: `Stored media record ${table}/${id} is corrupt`,
    safeMessage: 'Um registro local de midia esta corrompido.',
    severity: 'error',
    retryable: false,
    context: {
      scope: 'media.persistence',
      operation: 'read',
      table,
      id,
    },
  });
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isOptionalString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
