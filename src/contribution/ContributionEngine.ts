import type { PeerId } from '../network/NetworkTypes';
import type {
  ContributionEvent,
  ContributionEventType,
  ContributionMetrics,
  ContributionScore,
  ContributionStatistics,
} from './ContributionTypes';
import { ContributionMetricsManager } from './ContributionMetrics';
import { ContributionEvents } from './ContributionEvents';
import { ContributionLedger } from './ContributionLedger';
import { ContributionCalculator } from './ContributionCalculator';
import { ContributionValidator } from './ContributionValidator';
import { createLogger } from '../observability/Logger';

/**
 * ContributionEngine is the central coordinator for contribution tracking
 */
export class ContributionEngine {
  private metrics: ContributionMetricsManager;
  private events: ContributionEvents;
  private ledger: ContributionLedger;
  private calculator: ContributionCalculator;
  private validator: ContributionValidator;
  private scores: Map<PeerId, ContributionScore> = new Map();
  private startTime: number;
  private readonly logger = createLogger('contribution.engine');

  constructor() {
    this.metrics = new ContributionMetricsManager();
    this.events = new ContributionEvents();
    this.ledger = new ContributionLedger();
    this.calculator = new ContributionCalculator();
    this.validator = new ContributionValidator();
    this.startTime = Date.now();

    this.setupEventListeners();
  }

  /**
   * Setup event listeners to automatically update metrics and ledger
   */
  private setupEventListeners(): void {
    this.events.onAll((event) => {
      this.processEvent(event);
    });
  }

  /**
   * Process a contribution event
   */
  private processEvent(event: ContributionEvent): void {
    const appendResult = this.ledger.appendEntry(
      event.peerId,
      event.type,
      event.value,
      this.getEventDescription(event.type),
      {
        ...(event.metadata ?? {}),
        eventId: event.id,
      },
    );
    if (!appendResult.inserted) {
      return;
    }

    // Update metrics only after the source ledger accepted the event.
    this.updateMetricsFromEvent(event);

    // Recalculate score
    this.recalculateScore(event.peerId);

    // Track activity for fraud detection
    this.validator.trackActivity(event.peerId);
  }

  /**
   * Update metrics based on event type
   */
  private updateMetricsFromEvent(event: ContributionEvent): void {
    switch (event.type) {
      case 'STORAGE_SHARED':
        this.metrics.addStorageShared(event.peerId, event.value);
        break;
      case 'BANDWIDTH_SHARED':
        this.metrics.addBandwidthShared(event.peerId, event.value);
        break;
      case 'CHUNK_SERVED':
        this.metrics.incrementChunksServed(event.peerId);
        break;
      case 'CHUNK_DOWNLOADED':
        this.metrics.incrementChunksDownloaded(event.peerId);
        break;
      case 'POST_REPLICATED':
        this.metrics.incrementPostsReplicated(event.peerId);
        break;
      case 'MEDIA_REPLICATED':
        this.metrics.incrementMediaReplicated(event.peerId);
        break;
      case 'UPTIME':
        this.metrics.addUptime(event.peerId, event.value);
        break;
      case 'UPLOAD_FINISHED':
        this.metrics.incrementSuccessfulUploads(event.peerId);
        break;
      case 'DOWNLOAD_FINISHED':
        this.metrics.incrementSuccessfulDownloads(event.peerId);
        break;
      case 'REQUEST_RECEIVED':
        this.metrics.incrementRequestsReceived(event.peerId);
        break;
      default:
        break;
    }
  }

  /**
   * Get event description
   */
  private getEventDescription(type: ContributionEventType): string {
    const descriptions: Record<ContributionEventType, string> = {
      STORAGE_SHARED: 'Storage shared',
      BANDWIDTH_SHARED: 'Bandwidth shared',
      CHUNK_SERVED: 'Chunk served',
      CHUNK_DOWNLOADED: 'Chunk downloaded',
      POST_REPLICATED: 'Post replicated',
      MEDIA_REPLICATED: 'Media replicated',
      UPTIME: 'Uptime recorded',
      PEER_CONNECTED: 'Peer connected',
      PEER_DISCONNECTED: 'Peer disconnected',
      UPLOAD_FINISHED: 'Upload finished',
      DOWNLOAD_FINISHED: 'Download finished',
      REQUEST_RECEIVED: 'Request received',
      DATA_VALIDATED: 'Data validated',
      INVALID_DATA: 'Invalid data detected',
      SYBIL_DETECTED: 'Sybil attack detected',
      MANIPULATION_DETECTED: 'Manipulation detected',
    };
    return descriptions[type] || type;
  }

  /**
   * Emit a contribution event
   */
  emitEvent(
    type: ContributionEventType,
    peerId: PeerId,
    value: number,
    metadata?: Record<string, unknown>,
  ): ContributionEvent {
    return this.events.emit(type, peerId, value, metadata);
  }

  /**
   * Recalculate score for a peer
   */
  recalculateScore(peerId: PeerId): ContributionScore {
    const metrics = this.metrics.getMetrics(peerId);
    const score = this.calculator.calculateScore(metrics);
    this.scores.set(peerId, score);
    return score;
  }

  /**
   * Get score for a peer
   */
  getScore(peerId: PeerId): ContributionScore | null {
    if (!this.scores.has(peerId)) {
      this.recalculateScore(peerId);
    }
    return this.scores.get(peerId) || null;
  }

  /**
   * Get metrics for a peer
   */
  getMetrics(peerId: PeerId): ContributionMetrics {
    return this.metrics.getMetrics(peerId);
  }

  /**
   * Get all metrics
   */
  getAllMetrics(): ContributionMetrics[] {
    return this.metrics.getAllMetrics();
  }

  /**
   * Get all scores
   */
  getAllScores(): ContributionScore[] {
    return Array.from(this.scores.values());
  }

  /**
   * Get top contributors
   */
  getTopContributors(limit: number = 10): ContributionScore[] {
    return this.calculator.getTopContributors(this.getAllScores(), limit);
  }

  /**
   * Get ledger entries for a peer
   */
  getLedgerEntries(peerId: PeerId, limit?: number) {
    return this.ledger.getEntriesForPeer(peerId, limit);
  }

  /**
   * Get events for a peer
   */
  getEvents(peerId: PeerId, limit?: number): ContributionEvent[] {
    return this.events.getEventsForPeer(peerId, limit);
  }

  /**
   * Validate peer for fraud
   */
  validatePeer(peerId: PeerId) {
    const metrics = this.metrics.getMetrics(peerId);
    return this.validator.validateMetrics(metrics);
  }

  /**
   * Check if peer is suspicious
   */
  isPeerSuspicious(peerId: PeerId): boolean {
    return this.validator.isPeerSuspicious(peerId);
  }

  /**
   * Get suspicious peers
   */
  getSuspiciousPeers() {
    return this.validator.getSuspiciousPeers();
  }

  /**
   * Get statistics
   */
  getStatistics(): ContributionStatistics {
    const allMetrics = this.metrics.getAllMetrics();
    const allScores = this.getAllScores();

    const totalStorageShared = this.metrics.getTotalStorageShared();
    const totalBandwidthShared = this.metrics.getTotalBandwidthShared();
    const averageUptime = this.metrics.getAverageUptime();

    const averageTrustScore =
      allScores.length > 0
        ? allScores.reduce((sum, s) => sum + s.totalScore, 0) / allScores.length
        : 0;

    const topContributors = this.metrics.getTopContributorsByScore(10);

    return {
      totalPeers: allMetrics.length,
      totalStorageShared,
      totalBandwidthShared,
      totalChunksServed: allMetrics.reduce((sum, m) => sum + m.chunksServed, 0),
      averageUptime,
      averageTrustScore,
      topContributors,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Get engine uptime
   */
  getUptime(): number {
    return Date.now() - this.startTime;
  }

  /**
   * Add event listener
   */
  on(type: ContributionEventType, listener: (event: ContributionEvent) => void): void {
    this.events.on(type, listener);
  }

  /**
   * Add listener for all events
   */
  onAll(listener: (event: ContributionEvent) => void): void {
    this.events.onAll(listener);
  }

  /**
   * Remove event listener
   */
  off(type: ContributionEventType, listener: (event: ContributionEvent) => void): void {
    this.events.off(type, listener);
  }

  /**
   * Remove listener for all events
   */
  offAll(listener: (event: ContributionEvent) => void): void {
    this.events.offAll(listener);
  }

  /**
   * Reset peer data
   */
  resetPeer(peerId: PeerId): void {
    this.metrics.resetMetrics(peerId);
    this.ledger.deleteEntriesForPeer(peerId);
    this.scores.delete(peerId);
    this.validator.clearSuspiciousPeer(peerId);
  }

  /**
   * Clear all data
   */
  clearAll(): void {
    this.metrics.clearAll();
    this.events.clearAll();
    this.ledger.clearAll();
    this.scores.clear();
    this.validator.clearAllSuspicious();
    this.startTime = Date.now();
  }

  /**
   * Export data to JSON
   */
  exportToJSON(): string {
    return JSON.stringify(
      {
        metrics: this.metrics.getAllMetrics(),
        scores: this.getAllScores(),
        ledger: this.ledger.getAllEntries(),
        statistics: this.getStatistics(),
      },
      null,
      2,
    );
  }

  /**
   * Import data from JSON
   */
  importFromJSON(json: string): void {
    try {
      const data = JSON.parse(json) as {
        metrics?: ContributionMetrics[];
        scores?: ContributionScore[];
        ledger?: unknown[];
      };

      if (data.ledger) {
        this.ledger.importFromJSON(JSON.stringify(data.ledger));
      }

      if (data.metrics) {
        for (const metrics of data.metrics) {
          this.metrics.updateMetrics(metrics.peerId, metrics);
        }
      }

      if (data.scores) {
        for (const score of data.scores) {
          this.scores.set(score.peerId, score);
        }
      }
    } catch (error) {
      this.logger.error('import_failed', error);
    }
  }
}
