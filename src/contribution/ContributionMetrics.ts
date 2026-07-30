import type { PeerId } from '../network/NetworkTypes';
import type { ContributionMetrics } from './ContributionTypes';

/**
 * ContributionMetricsManager manages peer contribution metrics
 */
export class ContributionMetricsManager {
  private metrics: Map<PeerId, ContributionMetrics> = new Map();

  /**
   * Get metrics for a peer
   */
  getMetrics(peerId: PeerId): ContributionMetrics {
    if (!this.metrics.has(peerId)) {
      this.metrics.set(peerId, {
        peerId,
        storageShared: 0,
        bandwidthShared: 0,
        chunksServed: 0,
        chunksDownloaded: 0,
        postsReplicated: 0,
        mediaReplicated: 0,
        uptime: 0,
        successfulUploads: 0,
        successfulDownloads: 0,
        requestsReceived: 0,
        lastUpdated: Date.now(),
      });
    }
    return this.metrics.get(peerId)!;
  }

  /**
   * Update metrics for a peer
   */
  updateMetrics(peerId: PeerId, updates: Partial<ContributionMetrics>): void {
    const current = this.getMetrics(peerId);
    this.metrics.set(peerId, {
      ...current,
      ...updates,
      lastUpdated: Date.now(),
    });
  }

  /**
   * Add storage shared
   */
  addStorageShared(peerId: PeerId, bytes: number): void {
    const metrics = this.getMetrics(peerId);
    metrics.storageShared += bytes;
    metrics.lastUpdated = Date.now();
  }

  /**
   * Add bandwidth shared
   */
  addBandwidthShared(peerId: PeerId, bytes: number): void {
    const metrics = this.getMetrics(peerId);
    metrics.bandwidthShared += bytes;
    metrics.lastUpdated = Date.now();
  }

  /**
   * Increment chunks served
   */
  incrementChunksServed(peerId: PeerId): void {
    const metrics = this.getMetrics(peerId);
    metrics.chunksServed += 1;
    metrics.lastUpdated = Date.now();
  }

  /**
   * Increment chunks downloaded
   */
  incrementChunksDownloaded(peerId: PeerId): void {
    const metrics = this.getMetrics(peerId);
    metrics.chunksDownloaded += 1;
    metrics.lastUpdated = Date.now();
  }

  /**
   * Increment posts replicated
   */
  incrementPostsReplicated(peerId: PeerId): void {
    const metrics = this.getMetrics(peerId);
    metrics.postsReplicated += 1;
    metrics.lastUpdated = Date.now();
  }

  /**
   * Increment media replicated
   */
  incrementMediaReplicated(peerId: PeerId): void {
    const metrics = this.getMetrics(peerId);
    metrics.mediaReplicated += 1;
    metrics.lastUpdated = Date.now();
  }

  /**
   * Add uptime
   */
  addUptime(peerId: PeerId, seconds: number): void {
    const metrics = this.getMetrics(peerId);
    metrics.uptime += seconds;
    metrics.lastUpdated = Date.now();
  }

  /**
   * Increment successful uploads
   */
  incrementSuccessfulUploads(peerId: PeerId): void {
    const metrics = this.getMetrics(peerId);
    metrics.successfulUploads += 1;
    metrics.lastUpdated = Date.now();
  }

  /**
   * Increment successful downloads
   */
  incrementSuccessfulDownloads(peerId: PeerId): void {
    const metrics = this.getMetrics(peerId);
    metrics.successfulDownloads += 1;
    metrics.lastUpdated = Date.now();
  }

  /**
   * Increment requests received
   */
  incrementRequestsReceived(peerId: PeerId): void {
    const metrics = this.getMetrics(peerId);
    metrics.requestsReceived += 1;
    metrics.lastUpdated = Date.now();
  }

  /**
   * Get all metrics
   */
  getAllMetrics(): ContributionMetrics[] {
    return Array.from(this.metrics.values());
  }

  /**
   * Get total storage shared across all peers
   */
  getTotalStorageShared(): number {
    return Array.from(this.metrics.values()).reduce((sum, m) => sum + m.storageShared, 0);
  }

  /**
   * Get total bandwidth shared across all peers
   */
  getTotalBandwidthShared(): number {
    return Array.from(this.metrics.values()).reduce((sum, m) => sum + m.bandwidthShared, 0);
  }

  /**
   * Get average uptime across all peers
   */
  getAverageUptime(): number {
    const allMetrics = Array.from(this.metrics.values());
    if (allMetrics.length === 0) {
      return 0;
    }
    const totalUptime = allMetrics.reduce((sum, m) => sum + m.uptime, 0);
    return totalUptime / allMetrics.length;
  }

  /**
   * Get top contributors by storage
   */
  getTopContributorsByStorage(limit: number = 10): PeerId[] {
    return Array.from(this.metrics.values())
      .sort((a, b) => b.storageShared - a.storageShared)
      .slice(0, limit)
      .map((m) => m.peerId);
  }

  /**
   * Get top contributors by bandwidth
   */
  getTopContributorsByBandwidth(limit: number = 10): PeerId[] {
    return Array.from(this.metrics.values())
      .sort((a, b) => b.bandwidthShared - a.bandwidthShared)
      .slice(0, limit)
      .map((m) => m.peerId);
  }

  /**
   * Get top contributors by total score (weighted)
   */
  getTopContributorsByScore(limit: number = 10): PeerId[] {
    return Array.from(this.metrics.values())
      .sort((a, b) => {
        const scoreA = a.storageShared + a.bandwidthShared + a.chunksServed * 1024;
        const scoreB = b.storageShared + b.bandwidthShared + b.chunksServed * 1024;
        return scoreB - scoreA;
      })
      .slice(0, limit)
      .map((m) => m.peerId);
  }

  /**
   * Reset metrics for a peer
   */
  resetMetrics(peerId: PeerId): void {
    this.metrics.set(peerId, {
      peerId,
      storageShared: 0,
      bandwidthShared: 0,
      chunksServed: 0,
      chunksDownloaded: 0,
      postsReplicated: 0,
      mediaReplicated: 0,
      uptime: 0,
      successfulUploads: 0,
      successfulDownloads: 0,
      requestsReceived: 0,
      lastUpdated: Date.now(),
    });
  }

  /**
   * Remove metrics for a peer
   */
  removeMetrics(peerId: PeerId): void {
    this.metrics.delete(peerId);
  }

  /**
   * Clear all metrics
   */
  clearAll(): void {
    this.metrics.clear();
  }

  /**
   * Get metrics count
   */
  getCount(): number {
    return this.metrics.size;
  }
}
