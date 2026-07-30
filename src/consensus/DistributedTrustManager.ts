import type { PeerId } from '../network/NetworkTypes';
import type { DistributedTrustScore } from './ConsensusTypes';

/**
 * Trust report from a peer
 */
interface TrustReport {
  reporter: PeerId;
  peerId: PeerId;
  trustScore: number;
  timestamp: number;
  signature: string;
}

/**
 * Distributed Trust Manager handles trust aggregation and consensus
 */
export class DistributedTrustManager {
  private trustScores: Map<PeerId, DistributedTrustScore> = new Map();
  private trustReports: Map<string, TrustReport> = new Map();
  private reportsByPeer: Map<PeerId, Set<string>> = new Map();
  private reportsByReporter: Map<PeerId, Set<string>> = new Map();

  /**
   * Submit a trust report
   */
  submitTrustReport(
    reporter: PeerId,
    peerId: PeerId,
    trustScore: number,
    signature: string,
  ): boolean {
    // Validate trust score range
    if (trustScore < 0 || trustScore > 1000) {
      return false;
    }

    const reportId = `trust_report_${reporter}_${peerId}_${Date.now()}`;
    const report: TrustReport = {
      reporter,
      peerId,
      trustScore,
      timestamp: Date.now(),
      signature,
    };

    this.trustReports.set(reportId, report);

    // Track by peer
    if (!this.reportsByPeer.has(peerId)) {
      this.reportsByPeer.set(peerId, new Set());
    }
    this.reportsByPeer.get(peerId)!.add(reportId);

    // Track by reporter
    if (!this.reportsByReporter.has(reporter)) {
      this.reportsByReporter.set(reporter, new Set());
    }
    this.reportsByReporter.get(reporter)!.add(reportId);

    // Recalculate aggregated score
    this.recalculateAggregatedScore(peerId);

    return true;
  }

  /**
   * Recalculate aggregated trust score for a peer
   */
  private recalculateAggregatedScore(peerId: PeerId): void {
    const reportIds = this.reportsByPeer.get(peerId);
    if (!reportIds || reportIds.size === 0) {
      return;
    }

    const reports: TrustReport[] = [];
    for (const reportId of reportIds) {
      const report = this.trustReports.get(reportId);
      if (report) {
        reports.push(report);
      }
    }

    // Need at least 5 reports for consensus
    if (reports.length < 5) {
      return;
    }

    // Calculate average
    const sum = reports.reduce((total, report) => total + report.trustScore, 0);
    const networkScore = sum / reports.length;

    // Remove outliers (>2 standard deviations)
    const mean = networkScore;
    const variance =
      reports.reduce((total, report) => {
        return total + Math.pow(report.trustScore - mean, 2);
      }, 0) / reports.length;
    const stdDev = Math.sqrt(variance);

    const filteredReports = reports.filter((report) => {
      return Math.abs(report.trustScore - mean) <= 2 * stdDev;
    });

    // Calculate weighted average
    const weightedSum = filteredReports.reduce((total, report) => {
      // More recent reports have higher weight
      const age = Date.now() - report.timestamp;
      const weight = Math.max(0.5, 1 - age / (7 * 24 * 60 * 60 * 1000)); // Decay over 7 days
      return total + report.trustScore * weight;
    }, 0);

    const totalWeight = filteredReports.reduce((total, report) => {
      const age = Date.now() - report.timestamp;
      const weight = Math.max(0.5, 1 - age / (7 * 24 * 60 * 60 * 1000));
      return total + weight;
    }, 0);

    const aggregatedScore = weightedSum / totalWeight;

    // Update distributed trust score
    this.trustScores.set(peerId, {
      peerId,
      localScore: 0, // Will be set by local trust engine
      networkScore: Math.round(networkScore),
      aggregatedScore: Math.round(aggregatedScore),
      reporterCount: reportIds.size,
      lastUpdated: Date.now(),
      signatures: [],
    });
  }

  /**
   * Get distributed trust score for a peer
   */
  getTrustScore(peerId: PeerId): DistributedTrustScore | null {
    return this.trustScores.get(peerId) || null;
  }

  /**
   * Get all trust scores
   */
  getAllTrustScores(): DistributedTrustScore[] {
    return Array.from(this.trustScores.values());
  }

  /**
   * Get trust reports for a peer
   */
  getTrustReports(peerId: PeerId): TrustReport[] {
    const reportIds = this.reportsByPeer.get(peerId);
    if (!reportIds) {
      return [];
    }

    const reports: TrustReport[] = [];
    for (const reportId of reportIds) {
      const report = this.trustReports.get(reportId);
      if (report) {
        reports.push(report);
      }
    }

    return reports;
  }

  /**
   * Get trust reports by reporter
   */
  getTrustReportsByReporter(reporter: PeerId): TrustReport[] {
    const reportIds = this.reportsByReporter.get(reporter);
    if (!reportIds) {
      return [];
    }

    const reports: TrustReport[] = [];
    for (const reportId of reportIds) {
      const report = this.trustReports.get(reportId);
      if (report) {
        reports.push(report);
      }
    }

    return reports;
  }

  /**
   * Set local trust score (from local trust engine)
   */
  setLocalTrustScore(peerId: PeerId, localScore: number): void {
    const existingScore = this.trustScores.get(peerId);
    if (existingScore) {
      existingScore.localScore = localScore;
      // Recalculate aggregated score
      this.recalculateAggregatedScore(peerId);
    } else {
      this.trustScores.set(peerId, {
        peerId,
        localScore,
        networkScore: 0,
        aggregatedScore: localScore,
        reporterCount: 0,
        lastUpdated: Date.now(),
        signatures: [],
      });
    }
  }

  /**
   * Get top trusted peers
   */
  getTopTrustedPeers(limit: number = 10): DistributedTrustScore[] {
    return Array.from(this.trustScores.values())
      .sort((a, b) => b.aggregatedScore - a.aggregatedScore)
      .slice(0, limit);
  }

  /**
   * Get bottom trusted peers
   */
  getBottomTrustedPeers(limit: number = 10): DistributedTrustScore[] {
    return Array.from(this.trustScores.values())
      .sort((a, b) => a.aggregatedScore - b.aggregatedScore)
      .slice(0, limit);
  }

  /**
   * Remove trust report
   */
  removeTrustReport(reportId: string): boolean {
    const report = this.trustReports.get(reportId);
    if (!report) {
      return false;
    }

    // Remove from peer tracking
    const peerReports = this.reportsByPeer.get(report.peerId);
    if (peerReports) {
      peerReports.delete(reportId);
    }

    // Remove from reporter tracking
    const reporterReports = this.reportsByReporter.get(report.reporter);
    if (reporterReports) {
      reporterReports.delete(reportId);
    }

    // Recalculate aggregated score
    this.recalculateAggregatedScore(report.peerId);

    return this.trustReports.delete(reportId);
  }

  /**
   * Remove all trust reports for a peer
   */
  removeTrustReportsForPeer(peerId: PeerId): number {
    const reportIds = this.reportsByPeer.get(peerId);
    if (!reportIds) {
      return 0;
    }

    let count = 0;
    for (const reportId of reportIds) {
      if (this.removeTrustReport(reportId)) {
        count++;
      }
    }

    this.reportsByPeer.delete(peerId);
    return count;
  }

  /**
   * Clear all trust reports
   */
  clearAllTrustReports(): void {
    this.trustReports.clear();
    this.reportsByPeer.clear();
    this.reportsByReporter.clear();
  }

  /**
   * Clear all trust scores
   */
  clearAllTrustScores(): void {
    this.trustScores.clear();
  }

  /**
   * Get trust score count
   */
  getTrustScoreCount(): number {
    return this.trustScores.size;
  }

  /**
   * Get trust report count
   */
  getTrustReportCount(): number {
    return this.trustReports.size;
  }

  /**
   * Get statistics
   */
  getStatistics(): {
    totalTrustScores: number;
    totalTrustReports: number;
    averageAggregatedScore: number;
    averageNetworkScore: number;
    averageLocalScore: number;
    averageReporterCount: number;
  } {
    const trustScores = Array.from(this.trustScores.values());
    const totalTrustScores = trustScores.length;
    const totalTrustReports = this.trustReports.size;

    const averageAggregatedScore =
      totalTrustScores > 0
        ? trustScores.reduce((sum, score) => sum + score.aggregatedScore, 0) / totalTrustScores
        : 0;

    const averageNetworkScore =
      totalTrustScores > 0
        ? trustScores.reduce((sum, score) => sum + score.networkScore, 0) / totalTrustScores
        : 0;

    const averageLocalScore =
      totalTrustScores > 0
        ? trustScores.reduce((sum, score) => sum + score.localScore, 0) / totalTrustScores
        : 0;

    const averageReporterCount =
      totalTrustScores > 0
        ? trustScores.reduce((sum, score) => sum + score.reporterCount, 0) / totalTrustScores
        : 0;

    return {
      totalTrustScores,
      totalTrustReports,
      averageAggregatedScore,
      averageNetworkScore,
      averageLocalScore,
      averageReporterCount,
    };
  }

  /**
   * Export trust scores to JSON
   */
  exportTrustScoresToJSON(): string {
    return JSON.stringify(Array.from(this.trustScores.values()), null, 2);
  }

  /**
   * Import trust scores from JSON
   */
  importTrustScoresFromJSON(json: string): void {
    try {
      const scores = JSON.parse(json) as DistributedTrustScore[];
      for (const score of scores) {
        this.trustScores.set(score.peerId, score);
      }
    } catch (error) {
      console.error('[DistributedTrustManager] Failed to import trust scores from JSON:', error);
    }
  }

  /**
   * Export trust reports to JSON
   */
  exportTrustReportsToJSON(): string {
    return JSON.stringify(Array.from(this.trustReports.values()), null, 2);
  }

  /**
   * Import trust reports from JSON
   */
  importTrustReportsFromJSON(json: string): void {
    try {
      const reports = JSON.parse(json) as TrustReport[];
      for (const report of reports) {
        this.submitTrustReport(report.reporter, report.peerId, report.trustScore, report.signature);
      }
    } catch (error) {
      console.error('[DistributedTrustManager] Failed to import trust reports from JSON:', error);
    }
  }
}
