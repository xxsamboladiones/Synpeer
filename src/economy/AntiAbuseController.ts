import type { PeerId } from '../network/NetworkTypes';

/**
 * Abuse type
 */
export type AbuseType =
  | 'ARTIFICIAL_FARMING'
  | 'AUTO_DOWNLOAD'
  | 'AUTO_LIKE'
  | 'FAKE_STREAMING'
  | 'PEER_LOOPS'
  | 'RATE_LIMIT_EXCEEDED'
  | 'SUSPICIOUS_PATTERN';

/**
 * Abuse report
 */
export interface AbuseReport {
  id: string;
  peerId: PeerId;
  type: AbuseType;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  timestamp: number;
  description: string;
  evidence?: Record<string, unknown>;
  resolved: boolean;
  resolvedAt?: number;
  resolution?: string;
}

/**
 * Abuse statistics
 */
export interface AbuseStatistics {
  totalReports: number;
  resolvedReports: number;
  pendingReports: number;
  byType: Map<AbuseType, number>;
  bySeverity: Map<string, number>;
  topOffenders: Map<PeerId, number>;
}

/**
 * Anti Abuse Controller manages abuse detection and prevention
 */
export class AntiAbuseController {
  private reports: Map<string, AbuseReport> = new Map();
  private peerScores: Map<PeerId, number> = new Map();
  private reportCounter: number = 0;
  private peerActivity: Map<PeerId, number[]> = new Map();
  private peerConnections: Map<PeerId, Set<PeerId>> = new Map();
  private thresholds = {
    maxActivityPerMinute: 100,
    maxConnectionsPerPeer: 50,
    farmingThreshold: 0.8,
    loopThreshold: 10,
  };

  /**
   * Report abuse
   */
  reportAbuse(
    peerId: PeerId,
    type: AbuseType,
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
    description: string,
    evidence?: Record<string, unknown>,
  ): AbuseReport {
    const report: AbuseReport = {
      id: this.generateReportId(),
      peerId,
      type,
      severity,
      timestamp: Date.now(),
      description,
      evidence,
      resolved: false,
    };

    this.reports.set(report.id, report);

    // Update peer score
    const currentScore = this.peerScores.get(peerId) || 0;
    const severityScore = this.getSeverityScore(severity);
    this.peerScores.set(peerId, currentScore + severityScore);

    return report;
  }

  /**
   * Detect artificial farming
   */
  detectArtificialFarming(peerId: PeerId, contributionRate: number): boolean {
    if (contributionRate > this.thresholds.farmingThreshold) {
      this.reportAbuse(
        peerId,
        'ARTIFICIAL_FARMING',
        'HIGH',
        `Contribution rate ${contributionRate} exceeds threshold ${this.thresholds.farmingThreshold}`,
        { contributionRate },
      );
      return true;
    }
    return false;
  }

  /**
   * Detect auto-download
   */
  detectAutoDownload(peerId: PeerId, downloadCount: number, timeWindow: number): boolean {
    const rate = downloadCount / timeWindow;
    if (rate > this.thresholds.maxActivityPerMinute) {
      this.reportAbuse(
        peerId,
        'AUTO_DOWNLOAD',
        'MEDIUM',
        `Download rate ${rate} exceeds threshold ${this.thresholds.maxActivityPerMinute}`,
        { downloadCount, timeWindow, rate },
      );
      return true;
    }
    return false;
  }

  /**
   * Detect auto-like
   */
  detectAutoLike(peerId: PeerId, likeCount: number, timeWindow: number): boolean {
    const rate = likeCount / timeWindow;
    if (rate > this.thresholds.maxActivityPerMinute) {
      this.reportAbuse(
        peerId,
        'AUTO_LIKE',
        'MEDIUM',
        `Like rate ${rate} exceeds threshold ${this.thresholds.maxActivityPerMinute}`,
        { likeCount, timeWindow, rate },
      );
      return true;
    }
    return false;
  }

  /**
   * Detect fake streaming
   */
  detectFakeStreaming(peerId: PeerId, streamDuration: number, actualWatchTime: number): boolean {
    const ratio = actualWatchTime / streamDuration;
    if (ratio < 0.1) {
      // Less than 10% watched
      this.reportAbuse(
        peerId,
        'FAKE_STREAMING',
        'HIGH',
        `Watch ratio ${ratio} indicates fake streaming`,
        { streamDuration, actualWatchTime, ratio },
      );
      return true;
    }
    return false;
  }

  /**
   * Detect peer loops
   */
  detectPeerLoops(peerId: PeerId, connectedPeers: PeerId[]): boolean {
    // Check for circular connections
    for (const connectedPeer of connectedPeers) {
      const peerConnections = this.peerConnections.get(connectedPeer) || new Set();
      if (peerConnections.has(peerId)) {
        this.reportAbuse(
          peerId,
          'PEER_LOOPS',
          'HIGH',
          `Circular connection detected with peer ${connectedPeer}`,
          { connectedPeer },
        );
        return true;
      }
    }

    // Check for excessive connections
    if (connectedPeers.length > this.thresholds.maxConnectionsPerPeer) {
      this.reportAbuse(
        peerId,
        'PEER_LOOPS',
        'MEDIUM',
        `Connection count ${connectedPeers.length} exceeds threshold ${this.thresholds.maxConnectionsPerPeer}`,
        { connectionCount: connectedPeers.length },
      );
      return true;
    }

    return false;
  }

  /**
   * Detect suspicious patterns
   */
  detectSuspiciousPattern(peerId: PeerId, activities: number[]): boolean {
    // Check for repetitive patterns
    const patternScore = this.calculatePatternScore(activities);
    if (patternScore > 0.9) {
      this.reportAbuse(
        peerId,
        'SUSPICIOUS_PATTERN',
        'MEDIUM',
        `Suspicious pattern detected with score ${patternScore}`,
        { activities, patternScore },
      );
      return true;
    }
    return false;
  }

  /**
   * Calculate pattern score
   */
  private calculatePatternScore(activities: number[]): number {
    if (activities.length < 10) {
      return 0;
    }

    // Calculate variance
    const mean = activities.reduce((sum, a) => sum + a, 0) / activities.length;
    const variance =
      activities.reduce((sum, a) => sum + Math.pow(a - mean, 2), 0) / activities.length;

    // Low variance indicates repetitive pattern
    const normalizedVariance = variance / mean;
    return Math.max(0, 1 - normalizedVariance);
  }

  /**
   * Get severity score
   */
  private getSeverityScore(severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'): number {
    const scores = {
      LOW: 10,
      MEDIUM: 25,
      HIGH: 50,
      CRITICAL: 100,
    };
    return scores[severity];
  }

  /**
   * Get peer abuse score
   */
  getPeerScore(peerId: PeerId): number {
    return this.peerScores.get(peerId) || 0;
  }

  /**
   * Check if peer is banned
   */
  isPeerBanned(peerId: PeerId): boolean {
    const score = this.getPeerScore(peerId);
    return score >= 200; // Ban threshold
  }

  /**
   * Resolve abuse report
   */
  resolveReport(reportId: string, resolution: string): boolean {
    const report = this.reports.get(reportId);
    if (!report) {
      return false;
    }

    report.resolved = true;
    report.resolvedAt = Date.now();
    report.resolution = resolution;

    // Reduce peer score
    const currentScore = this.peerScores.get(report.peerId) || 0;
    const severityScore = this.getSeverityScore(report.severity);
    this.peerScores.set(report.peerId, Math.max(0, currentScore - severityScore));

    return true;
  }

  /**
   * Get report by ID
   */
  getReport(id: string): AbuseReport | null {
    return this.reports.get(id) || null;
  }

  /**
   * Get reports for peer
   */
  getReportsForPeer(peerId: PeerId): AbuseReport[] {
    return Array.from(this.reports.values()).filter((r) => r.peerId === peerId);
  }

  /**
   * Get reports by type
   */
  getReportsByType(type: AbuseType): AbuseReport[] {
    return Array.from(this.reports.values()).filter((r) => r.type === type);
  }

  /**
   * Get pending reports
   */
  getPendingReports(): AbuseReport[] {
    return Array.from(this.reports.values()).filter((r) => !r.resolved);
  }

  /**
   * Get all reports
   */
  getAllReports(): AbuseReport[] {
    return Array.from(this.reports.values());
  }

  /**
   * Update peer connections
   */
  updatePeerConnections(peerId: PeerId, connectedPeers: PeerId[]): void {
    this.peerConnections.set(peerId, new Set(connectedPeers));
  }

  /**
   * Get peer connections
   */
  getPeerConnections(peerId: PeerId): PeerId[] {
    const connections = this.peerConnections.get(peerId);
    return connections ? Array.from(connections) : [];
  }

  /**
   * Update thresholds
   */
  updateThresholds(thresholds: Partial<typeof this.thresholds>): void {
    this.thresholds = {
      ...this.thresholds,
      ...thresholds,
    };
  }

  /**
   * Get thresholds
   */
  getThresholds(): typeof this.thresholds {
    return { ...this.thresholds };
  }

  /**
   * Generate report ID
   */
  private generateReportId(): string {
    this.reportCounter++;
    return `abuse_${Date.now()}_${this.reportCounter}`;
  }

  /**
   * Get statistics
   */
  getStatistics(): AbuseStatistics {
    const reports = Array.from(this.reports.values());
    const totalReports = reports.length;
    const resolvedReports = reports.filter((r) => r.resolved).length;
    const pendingReports = totalReports - resolvedReports;

    const byType = new Map<AbuseType, number>();
    for (const report of reports) {
      const count = byType.get(report.type) || 0;
      byType.set(report.type, count + 1);
    }

    const bySeverity = new Map<string, number>();
    for (const report of reports) {
      const count = bySeverity.get(report.severity) || 0;
      bySeverity.set(report.severity, count + 1);
    }

    const topOffenders = new Map<PeerId, number>();
    for (const [peerId, score] of this.peerScores.entries()) {
      topOffenders.set(peerId, score);
    }

    return {
      totalReports,
      resolvedReports,
      pendingReports,
      byType,
      bySeverity,
      topOffenders,
    };
  }

  /**
   * Clear all reports
   */
  clearAllReports(): void {
    this.reports.clear();
  }

  /**
   * Clear peer scores
   */
  clearPeerScores(): void {
    this.peerScores.clear();
  }

  /**
   * Clear peer connections
   */
  clearPeerConnections(): void {
    this.peerConnections.clear();
  }

  /**
   * Export to JSON
   */
  exportToJSON(): string {
    return JSON.stringify(
      {
        reports: Array.from(this.reports.values()),
        peerScores: Array.from(this.peerScores.entries()),
        peerConnections: Array.from(this.peerConnections.entries()).map(([peerId, connections]) => [
          peerId,
          Array.from(connections),
        ]),
        thresholds: this.thresholds,
      },
      null,
      2,
    );
  }

  /**
   * Import from JSON
   */
  importFromJSON(json: string): void {
    try {
      const data = JSON.parse(json) as {
        reports?: AbuseReport[];
        peerScores?: [PeerId, number][];
        peerConnections?: [PeerId, PeerId[]][];
        thresholds?: Partial<{
          maxActivityPerMinute: number;
          maxConnectionsPerPeer: number;
          farmingThreshold: number;
          loopThreshold: number;
        }>;
      };

      if (data.reports) {
        for (const report of data.reports) {
          this.reports.set(report.id, report);
        }
      }

      if (data.peerScores) {
        for (const [peerId, score] of data.peerScores) {
          this.peerScores.set(peerId, score);
        }
      }

      if (data.peerConnections) {
        for (const [peerId, connections] of data.peerConnections) {
          this.peerConnections.set(peerId, new Set(connections));
        }
      }

      if (data.thresholds) {
        this.updateThresholds(data.thresholds);
      }
    } catch (error) {
      console.error('[AntiAbuseController] Failed to import from JSON:', error);
    }
  }
}
