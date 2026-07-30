import type { DatabaseService } from '@/database/DatabaseService';
import { AppError, toAppError } from '@/errors/AppError';
import type { PeerId } from '@/network/NetworkTypes';
import type { StorageService } from '@/services/storage/StorageService';

import type { MediaDownloadState, MediaDownloadStatus } from './PeerMediaSyncService';

export const LEGACY_MEDIA_DOWNLOAD_STATES_KEY = 'media_download_states';
export const LEGACY_MEDIA_AVAILABILITY_KEY = 'media_availability_manifests';

const DOWNLOAD_TABLE = 'media_download_jobs';
const AVAILABILITY_TABLE = 'media_availability_announcements';
const MEDIA_PERSISTENCE_SCHEMA_VERSION = 1;

export interface MediaAvailabilityItem {
  mediaObjectId: string;
  chunks: string[];
  totalChunks: number;
  updatedAt: number;
}

export interface MediaAvailabilityManifest {
  peerId: PeerId;
  items: MediaAvailabilityItem[];
  updatedAt: number;
}

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

export class MediaDownloadRepository {
  private readonly states = new Map<string, MediaDownloadState>();
  private readonly manifests = new Map<PeerId, MediaAvailabilityManifest>();
  private initialization: Promise<MediaPersistenceMigrationResult> | null = null;
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

  findPeersForMedia(mediaObjectId: string): PeerId[] {
    return this.listManifests()
      .filter((manifest) => manifest.items.some((item) => item.mediaObjectId === mediaObjectId))
      .map((manifest) => manifest.peerId);
  }

  findPeersForChunk(mediaObjectId: string, chunkId: string): PeerId[] {
    return this.listManifests()
      .filter((manifest) =>
        manifest.items.some(
          (item) => item.mediaObjectId === mediaObjectId && item.chunks.includes(chunkId),
        ),
      )
      .map((manifest) => manifest.peerId);
  }

  async clear(): Promise<void> {
    this.assertInitialized();
    await this.database.transaction(async (transaction) => {
      await transaction.run(`DELETE FROM ${DOWNLOAD_TABLE};`);
      await transaction.run(`DELETE FROM ${AVAILABILITY_TABLE};`);
    });
    this.states.clear();
    this.manifests.clear();
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
      manifestRows.map((row) => {
        const manifest = mapAvailabilityRow(row);
        return [manifest.peerId, manifest];
      }),
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
    const manifests = (await this.readManifestRows()).map(mapAvailabilityRow);
    this.states.clear();
    this.manifests.clear();
    for (const state of states) {
      this.states.set(state.mediaObjectId, cloneDownloadState(state));
    }
    for (const manifest of manifests) {
      this.manifests.set(manifest.peerId, cloneManifest(manifest));
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

  private async writeState(state: MediaDownloadState, database: DatabaseService): Promise<void> {
    await database.run(
      `
      INSERT OR REPLACE INTO ${DOWNLOAD_TABLE}
      (id, schemaVersion, status, totalChunks, downloadedChunks, requestedChunks, failedChunks, candidatePeers, error, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      [
        state.mediaObjectId,
        MEDIA_PERSISTENCE_SCHEMA_VERSION,
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
        MEDIA_PERSISTENCE_SCHEMA_VERSION,
        manifest.peerId,
        JSON.stringify(manifest.items),
        manifest.updatedAt,
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

function mapAvailabilityRow(row: MediaAvailabilityRow): MediaAvailabilityManifest {
  let items: unknown;
  try {
    items = JSON.parse(row.items);
  } catch {
    throw corruptRowError(AVAILABILITY_TABLE, row.id);
  }
  const manifest: unknown = {
    peerId: row.peerId,
    items,
    updatedAt: row.updatedAt,
  };
  if (!isMediaAvailabilityManifest(manifest) || manifest.peerId !== row.id) {
    throw corruptRowError(AVAILABILITY_TABLE, row.id);
  }
  return normalizeManifest(manifest);
}

function assertDownloadJobRow(value: unknown): MediaDownloadJobRow {
  if (!isRecord(value)) {
    throw corruptRowError(DOWNLOAD_TABLE, 'unknown');
  }
  if (
    typeof value.id !== 'string' ||
    value.schemaVersion !== MEDIA_PERSISTENCE_SCHEMA_VERSION ||
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
    value.schemaVersion !== MEDIA_PERSISTENCE_SCHEMA_VERSION ||
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

function isMediaAvailabilityItem(value: unknown): value is MediaAvailabilityItem {
  return (
    isRecord(value) &&
    typeof value.mediaObjectId === 'string' &&
    Array.isArray(value.chunks) &&
    value.chunks.every((chunkId) => typeof chunkId === 'string') &&
    isNonNegativeInteger(value.totalChunks) &&
    isTimestamp(value.updatedAt)
  );
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
