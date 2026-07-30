import { DatabaseService } from '../database/DatabaseService';
import type {
  ContributionMetrics,
  TrustScore,
  LedgerEntry,
} from '../contribution/ContributionTypes';

/**
 * Contribution repository for local SQLite storage
 */
export class ContributionRepository {
  private db: DatabaseService;
  private metricsTableName = 'contribution_metrics';
  private trustScoresTableName = 'trust_scores';
  private ledgerTableName = 'contribution_ledger';

  constructor(db: DatabaseService) {
    this.db = db;
    this.initializeTables();
  }

  /**
   * Initialize contribution tables
   */
  private async initializeTables(): Promise<void> {
    // Metrics table
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${this.metricsTableName} (
        peerId TEXT PRIMARY KEY,
        storageShared INTEGER NOT NULL DEFAULT 0,
        bandwidthShared INTEGER NOT NULL DEFAULT 0,
        chunksServed INTEGER NOT NULL DEFAULT 0,
        chunksDownloaded INTEGER NOT NULL DEFAULT 0,
        postsReplicated INTEGER NOT NULL DEFAULT 0,
        mediaReplicated INTEGER NOT NULL DEFAULT 0,
        uptime INTEGER NOT NULL DEFAULT 0,
        successfulUploads INTEGER NOT NULL DEFAULT 0,
        successfulDownloads INTEGER NOT NULL DEFAULT 0,
        requestsReceived INTEGER NOT NULL DEFAULT 0,
        lastUpdated INTEGER NOT NULL
      );
    `);

    // Trust scores table
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${this.trustScoresTableName} (
        peerId TEXT PRIMARY KEY,
        score INTEGER NOT NULL DEFAULT 500,
        availability INTEGER NOT NULL DEFAULT 0,
        latency INTEGER NOT NULL DEFAULT 0,
        successfulResponses INTEGER NOT NULL DEFAULT 0,
        failedResponses INTEGER NOT NULL DEFAULT 0,
        lastUpdated INTEGER NOT NULL
      );
    `);

    // Ledger table
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${this.ledgerTableName} (
        id TEXT PRIMARY KEY,
        peerId TEXT NOT NULL,
        eventType TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        value INTEGER NOT NULL,
        description TEXT NOT NULL,
        metadata TEXT
      );
    `);

    // Create indexes
    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_ledger_peerId ON ${this.ledgerTableName}(peerId);
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_ledger_timestamp ON ${this.ledgerTableName}(timestamp);
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_ledger_eventType ON ${this.ledgerTableName}(eventType);
    `);
  }

  /**
   * Save or update metrics for a peer
   */
  async saveMetrics(metrics: ContributionMetrics): Promise<void> {
    await this.db.run(
      `
      INSERT OR REPLACE INTO ${this.metricsTableName}
      (peerId, storageShared, bandwidthShared, chunksServed, chunksDownloaded, postsReplicated, mediaReplicated, uptime, successfulUploads, successfulDownloads, requestsReceived, lastUpdated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
      [
        metrics.peerId,
        metrics.storageShared,
        metrics.bandwidthShared,
        metrics.chunksServed,
        metrics.chunksDownloaded,
        metrics.postsReplicated,
        metrics.mediaReplicated,
        metrics.uptime,
        metrics.successfulUploads,
        metrics.successfulDownloads,
        metrics.requestsReceived,
        metrics.lastUpdated,
      ],
    );
  }

  /**
   * Get metrics for a peer
   */
  async getMetrics(peerId: string): Promise<ContributionMetrics | null> {
    const result = await this.db.query(
      `
      SELECT * FROM ${this.metricsTableName} WHERE peerId = ?;
    `,
      [peerId],
    );

    if (result.length === 0) {
      return null;
    }

    return this.mapRowToMetrics(result[0]);
  }

  /**
   * Get all metrics
   */
  async getAllMetrics(limit?: number, offset?: number): Promise<ContributionMetrics[]> {
    let query = `SELECT * FROM ${this.metricsTableName} ORDER BY lastUpdated DESC`;
    const params: (string | number)[] = [];

    if (limit !== undefined) {
      query += ` LIMIT ?`;
      params.push(limit);
    }

    if (offset !== undefined) {
      query += ` OFFSET ?`;
      params.push(offset);
    }

    const result = await this.db.query(query, params);
    return result.map((row) => this.mapRowToMetrics(row));
  }

  /**
   * Delete metrics for a peer
   */
  async deleteMetrics(peerId: string): Promise<void> {
    await this.db.run(
      `
      DELETE FROM ${this.metricsTableName} WHERE peerId = ?;
    `,
      [peerId],
    );
  }

  /**
   * Save or update trust score for a peer
   */
  async saveTrustScore(trust: TrustScore): Promise<void> {
    await this.db.run(
      `
      INSERT OR REPLACE INTO ${this.trustScoresTableName}
      (peerId, score, availability, latency, successfulResponses, failedResponses, lastUpdated)
      VALUES (?, ?, ?, ?, ?, ?, ?);
    `,
      [
        trust.peerId,
        trust.score,
        trust.availability,
        trust.latency,
        trust.successfulResponses,
        trust.failedResponses,
        trust.lastUpdated,
      ],
    );
  }

  /**
   * Get trust score for a peer
   */
  async getTrustScore(peerId: string): Promise<TrustScore | null> {
    const result = await this.db.query(
      `
      SELECT * FROM ${this.trustScoresTableName} WHERE peerId = ?;
    `,
      [peerId],
    );

    if (result.length === 0) {
      return null;
    }

    return this.mapRowToTrustScore(result[0]);
  }

  /**
   * Get all trust scores
   */
  async getAllTrustScores(limit?: number, offset?: number): Promise<TrustScore[]> {
    let query = `SELECT * FROM ${this.trustScoresTableName} ORDER BY score DESC`;
    const params: (string | number)[] = [];

    if (limit !== undefined) {
      query += ` LIMIT ?`;
      params.push(limit);
    }

    if (offset !== undefined) {
      query += ` OFFSET ?`;
      params.push(offset);
    }

    const result = await this.db.query(query, params);
    return result.map((row) => this.mapRowToTrustScore(row));
  }

  /**
   * Delete trust score for a peer
   */
  async deleteTrustScore(peerId: string): Promise<void> {
    await this.db.run(
      `
      DELETE FROM ${this.trustScoresTableName} WHERE peerId = ?;
    `,
      [peerId],
    );
  }

  /**
   * Add ledger entry
   */
  async addLedgerEntry(entry: LedgerEntry): Promise<void> {
    await this.db.run(
      `
      INSERT OR REPLACE INTO ${this.ledgerTableName}
      (id, peerId, eventType, timestamp, value, description, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?);
    `,
      [
        entry.id,
        entry.peerId,
        entry.eventType,
        entry.timestamp,
        entry.value,
        entry.description,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      ],
    );
  }

  /**
   * Get ledger entries for a peer
   */
  async getLedgerEntries(peerId: string, limit?: number, offset?: number): Promise<LedgerEntry[]> {
    let query = `SELECT * FROM ${this.ledgerTableName} WHERE peerId = ? ORDER BY timestamp DESC`;
    const params: (string | number)[] = [peerId];

    if (limit !== undefined) {
      query += ` LIMIT ?`;
      params.push(limit);
    }

    if (offset !== undefined) {
      query += ` OFFSET ?`;
      params.push(offset);
    }

    const result = await this.db.query(query, params);
    return result.map((row) => this.mapRowToLedgerEntry(row));
  }

  /**
   * Get ledger entries by event type
   */
  async getLedgerEntriesByType(
    eventType: string,
    limit?: number,
    offset?: number,
  ): Promise<LedgerEntry[]> {
    let query = `SELECT * FROM ${this.ledgerTableName} WHERE eventType = ? ORDER BY timestamp DESC`;
    const params: (string | number)[] = [eventType];

    if (limit !== undefined) {
      query += ` LIMIT ?`;
      params.push(limit);
    }

    if (offset !== undefined) {
      query += ` OFFSET ?`;
      params.push(offset);
    }

    const result = await this.db.query(query, params);
    return result.map((row) => this.mapRowToLedgerEntry(row));
  }

  /**
   * Get ledger entries in time range
   */
  async getLedgerEntriesInTimeRange(
    startTime: number,
    endTime: number,
    limit?: number,
  ): Promise<LedgerEntry[]> {
    let query = `SELECT * FROM ${this.ledgerTableName} WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC`;
    const params: (string | number)[] = [startTime, endTime];

    if (limit !== undefined) {
      query += ` LIMIT ?`;
      params.push(limit);
    }

    const result = await this.db.query(query, params);
    return result.map((row) => this.mapRowToLedgerEntry(row));
  }

  /**
   * Delete ledger entry
   */
  async deleteLedgerEntry(id: string): Promise<void> {
    await this.db.run(
      `
      DELETE FROM ${this.ledgerTableName} WHERE id = ?;
    `,
      [id],
    );
  }

  /**
   * Delete ledger entries for a peer
   */
  async deleteLedgerEntriesForPeer(peerId: string): Promise<void> {
    await this.db.run(
      `
      DELETE FROM ${this.ledgerTableName} WHERE peerId = ?;
    `,
      [peerId],
    );
  }

  /**
   * Get total storage shared
   */
  async getTotalStorageShared(): Promise<number> {
    const result = await this.db.query(`
      SELECT SUM(storageShared) as total FROM ${this.metricsTableName};
    `);
    return (result[0] as { total: number | null }).total || 0;
  }

  /**
   * Get total bandwidth shared
   */
  async getTotalBandwidthShared(): Promise<number> {
    const result = await this.db.query(`
      SELECT SUM(bandwidthShared) as total FROM ${this.metricsTableName};
    `);
    return (result[0] as { total: number | null }).total || 0;
  }

  /**
   * Get average trust score
   */
  async getAverageTrustScore(): Promise<number> {
    const result = await this.db.query(`
      SELECT AVG(score) as average FROM ${this.trustScoresTableName};
    `);
    return (result[0] as { average: number | null }).average || 0;
  }

  /**
   * Map database row to metrics
   */
  private mapRowToMetrics(row: unknown): ContributionMetrics {
    const r = row as {
      peerId: string;
      storageShared: number;
      bandwidthShared: number;
      chunksServed: number;
      chunksDownloaded: number;
      postsReplicated: number;
      mediaReplicated: number;
      uptime: number;
      successfulUploads: number;
      successfulDownloads: number;
      requestsReceived: number;
      lastUpdated: number;
    };
    return {
      peerId: r.peerId,
      storageShared: r.storageShared,
      bandwidthShared: r.bandwidthShared,
      chunksServed: r.chunksServed,
      chunksDownloaded: r.chunksDownloaded,
      postsReplicated: r.postsReplicated,
      mediaReplicated: r.mediaReplicated,
      uptime: r.uptime,
      successfulUploads: r.successfulUploads,
      successfulDownloads: r.successfulDownloads,
      requestsReceived: r.requestsReceived,
      lastUpdated: r.lastUpdated,
    };
  }

  /**
   * Map database row to trust score
   */
  private mapRowToTrustScore(row: unknown): TrustScore {
    const r = row as {
      peerId: string;
      score: number;
      availability: number;
      latency: number;
      successfulResponses: number;
      failedResponses: number;
      lastUpdated: number;
    };
    return {
      peerId: r.peerId,
      score: r.score,
      availability: r.availability,
      latency: r.latency,
      successfulResponses: r.successfulResponses,
      failedResponses: r.failedResponses,
      lastUpdated: r.lastUpdated,
    };
  }

  /**
   * Map database row to ledger entry
   */
  private mapRowToLedgerEntry(row: unknown): LedgerEntry {
    const r = row as {
      id: string;
      peerId: string;
      eventType: string;
      timestamp: number;
      value: number;
      description: string;
      metadata: string | null;
    };
    return {
      id: r.id,
      peerId: r.peerId,
      eventType: r.eventType as LedgerEntry['eventType'],
      timestamp: r.timestamp,
      value: r.value,
      description: r.description,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    };
  }
}
