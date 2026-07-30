import type { DatabaseService } from '@/database/DatabaseService';
import { AppError } from '@/errors/AppError';
import type { PeerId } from '@/network/NetworkTypes';

import { SYNC_ENTITIES, type SyncEntity } from './IncrementalSyncService';

const TABLE_NAME = 'sync_checkpoints';

export type SyncCheckpointStatus = 'scanning' | 'complete';

export interface SyncCheckpoint {
  id: string;
  peerId: PeerId;
  entity: SyncEntity;
  cursor?: string;
  manifestHash: string;
  status: SyncCheckpointStatus;
  syncedObjects: number;
  updatedAt: number;
}

interface SyncCheckpointRow {
  id: string;
  peerId: string;
  entity: string;
  cursor: string | null;
  manifestHash: string;
  status: string;
  syncedObjects: number;
  updatedAt: number;
}

export class SyncCheckpointRepository {
  private readonly initialized: Promise<void>;

  constructor(private readonly database: DatabaseService) {
    this.initialized = this.initializeTable();
  }

  async get(peerId: PeerId, entity: SyncEntity): Promise<SyncCheckpoint | null> {
    await this.initialized;
    return await this.getFrom(this.database, peerId, entity);
  }

  async list(peerId?: PeerId): Promise<SyncCheckpoint[]> {
    await this.initialized;
    const rows = peerId
      ? await this.database.query(`SELECT * FROM ${TABLE_NAME} WHERE peerId = ?;`, [peerId])
      : await this.database.query(`SELECT * FROM ${TABLE_NAME};`);
    return rows.map(mapCheckpointRow).sort(compareCheckpoints);
  }

  async saveProgress(input: {
    peerId: PeerId;
    entity: SyncEntity;
    cursor?: string;
    manifestHash: string;
    syncedObjects?: number;
    now?: number;
  }): Promise<SyncCheckpoint> {
    await this.initialized;
    return await this.database.transaction(async (transaction) => {
      const existing = await this.getFrom(transaction, input.peerId, input.entity);
      return await this.write(
        {
          id: createCheckpointId(input.peerId, input.entity),
          peerId: input.peerId,
          entity: input.entity,
          cursor: input.cursor,
          manifestHash: input.manifestHash,
          status: 'scanning',
          syncedObjects:
            (existing?.manifestHash === input.manifestHash ? existing.syncedObjects : 0) +
            Math.max(0, input.syncedObjects ?? 0),
          updatedAt: input.now ?? Date.now(),
        },
        transaction,
      );
    });
  }

  async markComplete(input: {
    peerId: PeerId;
    entity: SyncEntity;
    manifestHash: string;
    syncedObjects?: number;
    now?: number;
  }): Promise<SyncCheckpoint> {
    await this.initialized;
    return await this.database.transaction(async (transaction) => {
      const existing = await this.getFrom(transaction, input.peerId, input.entity);
      return await this.write(
        {
          id: createCheckpointId(input.peerId, input.entity),
          peerId: input.peerId,
          entity: input.entity,
          manifestHash: input.manifestHash,
          status: 'complete',
          syncedObjects:
            (existing?.manifestHash === input.manifestHash ? existing.syncedObjects : 0) +
            Math.max(0, input.syncedObjects ?? 0),
          updatedAt: input.now ?? Date.now(),
        },
        transaction,
      );
    });
  }

  async clearPeer(peerId: PeerId): Promise<void> {
    await this.initialized;
    await this.database.run(`DELETE FROM ${TABLE_NAME} WHERE peerId = ?;`, [peerId]);
  }

  async clear(): Promise<void> {
    await this.initialized;
    await this.database.run(`DELETE FROM ${TABLE_NAME};`);
  }

  private async initializeTable(): Promise<void> {
    await this.database.execute(`
      CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
        id TEXT PRIMARY KEY,
        peerId TEXT NOT NULL,
        entity TEXT NOT NULL,
        cursor TEXT,
        manifestHash TEXT NOT NULL,
        status TEXT NOT NULL,
        syncedObjects INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL
      );
    `);
    await this.database.execute(
      `CREATE INDEX IF NOT EXISTS idx_sync_checkpoints_peer ON ${TABLE_NAME}(peerId);`,
    );
    await this.database.execute(
      `CREATE INDEX IF NOT EXISTS idx_sync_checkpoints_entity ON ${TABLE_NAME}(entity);`,
    );
  }

  private async getFrom(
    database: DatabaseService,
    peerId: PeerId,
    entity: SyncEntity,
  ): Promise<SyncCheckpoint | null> {
    const rows = await database.query(`SELECT * FROM ${TABLE_NAME} WHERE id = ?;`, [
      createCheckpointId(peerId, entity),
    ]);
    return rows.length === 0 ? null : mapCheckpointRow(rows[0]);
  }

  private async write(
    checkpoint: SyncCheckpoint,
    database: DatabaseService = this.database,
  ): Promise<SyncCheckpoint> {
    await this.initialized;
    await database.run(
      `
      INSERT OR REPLACE INTO ${TABLE_NAME}
      (id, peerId, entity, cursor, manifestHash, status, syncedObjects, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?);
      `,
      [
        checkpoint.id,
        checkpoint.peerId,
        checkpoint.entity,
        checkpoint.cursor ?? null,
        checkpoint.manifestHash,
        checkpoint.status,
        checkpoint.syncedObjects,
        checkpoint.updatedAt,
      ],
    );
    return checkpoint;
  }
}

export function createCheckpointId(peerId: PeerId, entity: SyncEntity): string {
  return `${peerId}:${entity}`;
}

function mapCheckpointRow(value: unknown): SyncCheckpoint {
  if (!isCheckpointRow(value)) {
    throw new AppError({
      code: 'STORAGE_ERROR',
      message: 'Stored sync checkpoint is corrupt',
      safeMessage: 'Um checkpoint de sincronizacao local esta corrompido.',
      severity: 'error',
      retryable: false,
      context: {
        scope: 'sync.checkpoints',
        operation: 'read',
      },
    });
  }
  return {
    id: value.id,
    peerId: value.peerId as PeerId,
    entity: value.entity,
    cursor: value.cursor ?? undefined,
    manifestHash: value.manifestHash,
    status: value.status,
    syncedObjects: value.syncedObjects,
    updatedAt: value.updatedAt,
  };
}

function isCheckpointRow(value: unknown): value is SyncCheckpointRow & {
  entity: SyncEntity;
  status: SyncCheckpointStatus;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    typeof row.peerId === 'string' &&
    typeof row.entity === 'string' &&
    SYNC_ENTITIES.includes(row.entity as SyncEntity) &&
    (row.cursor === null || row.cursor === undefined || typeof row.cursor === 'string') &&
    typeof row.manifestHash === 'string' &&
    (row.status === 'scanning' || row.status === 'complete') &&
    typeof row.syncedObjects === 'number' &&
    Number.isFinite(row.syncedObjects) &&
    typeof row.updatedAt === 'number' &&
    Number.isFinite(row.updatedAt)
  );
}

function compareCheckpoints(left: SyncCheckpoint, right: SyncCheckpoint): number {
  return left.peerId.localeCompare(right.peerId) || left.entity.localeCompare(right.entity);
}
