import type { PeerId } from '../network/NetworkTypes';
import type { PeerFingerprint, FraudReport } from './ConsensusTypes';

/**
 * Verification result
 */
export interface VerificationResult {
  verified: boolean;
  reason?: string;
  confidence: number; // 0-100
  timestamp: number;
}

/**
 * Sybil detection result
 */
export interface SybilDetectionResult {
  isSybil: boolean;
  confidence: number; // 0-100
  evidence: string[];
  relatedPeers: PeerId[];
  timestamp: number;
}

/**
 * Peer Verification handles identity verification and anti-sybil
 */
export class PeerVerification {
  private fingerprints: Map<PeerId, PeerFingerprint> = new Map();
  private fraudReports: Map<string, FraudReport> = new Map();
  private suspiciousPeers: Set<PeerId> = new Set();
  private bannedPeers: Set<PeerId> = new Set();

  /**
   * Register peer fingerprint
   */
  registerFingerprint(fingerprint: PeerFingerprint): void {
    this.fingerprints.set(fingerprint.peerId, fingerprint);
  }

  /**
   * Verify peer identity
   */
  verifyPeer(peerId: PeerId): VerificationResult {
    const fingerprint = this.fingerprints.get(peerId);

    if (!fingerprint) {
      return {
        verified: false,
        reason: 'Peer fingerprint not found',
        confidence: 0,
        timestamp: Date.now(),
      };
    }

    // Check if peer is banned
    if (this.bannedPeers.has(peerId)) {
      return {
        verified: false,
        reason: 'Peer is banned',
        confidence: 100,
        timestamp: Date.now(),
      };
    }

    // Check if peer is suspicious
    if (this.suspiciousPeers.has(peerId)) {
      return {
        verified: false,
        reason: 'Peer is marked as suspicious',
        confidence: 75,
        timestamp: Date.now(),
      };
    }

    // Check if peer is recently created (potential Sybil)
    const age = Date.now() - fingerprint.creationTime;
    if (age < 5 * 60 * 1000) {
      // Less than 5 minutes old
      return {
        verified: true,
        reason: 'Peer is recently created, monitor closely',
        confidence: 50,
        timestamp: Date.now(),
      };
    }

    // Check if peer has sufficient activity
    if (fingerprint.connectionCount < 3) {
      return {
        verified: true,
        reason: 'Peer has low activity',
        confidence: 70,
        timestamp: Date.now(),
      };
    }

    return {
      verified: true,
      confidence: 100,
      timestamp: Date.now(),
    };
  }

  /**
   * Detect Sybil attack
   */
  detectSybil(peerId: PeerId): SybilDetectionResult {
    const fingerprint = this.fingerprints.get(peerId);

    if (!fingerprint) {
      return {
        isSybil: false,
        confidence: 0,
        evidence: [],
        relatedPeers: [],
        timestamp: Date.now(),
      };
    }

    const evidence: string[] = [];
    const relatedPeers: PeerId[] = [];
    let confidence = 0;

    // Check for same IP address
    for (const [otherId, otherFingerprint] of this.fingerprints.entries()) {
      if (otherId === peerId) {
        continue;
      }

      if (otherFingerprint.ipAddress === fingerprint.ipAddress) {
        evidence.push(`Same IP address as peer ${otherId}`);
        relatedPeers.push(otherId);
        confidence += 30;
      }

      // Check for same behavior pattern
      if (otherFingerprint.behaviorPattern === fingerprint.behaviorPattern) {
        evidence.push(`Same behavior pattern as peer ${otherId}`);
        relatedPeers.push(otherId);
        confidence += 20;
      }

      // Check for same user agent
      if (otherFingerprint.userAgent === fingerprint.userAgent) {
        evidence.push(`Same user agent as peer ${otherId}`);
        relatedPeers.push(otherId);
        confidence += 15;
      }

      // Check for same creation time (within 2 minutes)
      const timeDiff = Math.abs(fingerprint.creationTime - otherFingerprint.creationTime);
      if (timeDiff < 2 * 60 * 1000) {
        evidence.push(`Created at same time as peer ${otherId}`);
        relatedPeers.push(otherId);
        confidence += 25;
      }
    }

    // Check for burst creation pattern
    const recentPeers = this.getRecentlyCreatedPeers(2 * 60 * 1000); // Last 2 minutes
    if (recentPeers.length > 10) {
      evidence.push('Burst peer creation detected');
      confidence += 40;
    }

    const isSybil = confidence > 50;

    return {
      isSybil,
      confidence: Math.min(100, confidence),
      evidence,
      relatedPeers,
      timestamp: Date.now(),
    };
  }

  /**
   * Get recently created peers
   */
  private getRecentlyCreatedPeers(timeWindow: number): PeerFingerprint[] {
    const now = Date.now();
    return Array.from(this.fingerprints.values()).filter((f) => now - f.creationTime < timeWindow);
  }

  /**
   * Report fraud
   */
  reportFraud(report: FraudReport): void {
    this.fraudReports.set(report.reportId, report);

    // If fraud is confirmed, mark peer as suspicious
    if (report.fraudType === 'SYBIL' || report.fraudType === 'MANIPULATION') {
      this.suspiciousPeers.add(report.accused);
    }

    // If fraud is severe, ban peer
    if (report.fraudType === 'SYBIL') {
      this.bannedPeers.add(report.accused);
    }
  }

  /**
   * Get fraud reports for a peer
   */
  getFraudReports(peerId: PeerId): FraudReport[] {
    return Array.from(this.fraudReports.values()).filter((r) => r.accused === peerId);
  }

  /**
   * Get fraud reports by type
   */
  getFraudReportsByType(fraudType: FraudReport['fraudType']): FraudReport[] {
    return Array.from(this.fraudReports.values()).filter((r) => r.fraudType === fraudType);
  }

  /**
   * Check if peer is suspicious
   */
  isSuspicious(peerId: PeerId): boolean {
    return this.suspiciousPeers.has(peerId);
  }

  /**
   * Check if peer is banned
   */
  isBanned(peerId: PeerId): boolean {
    return this.bannedPeers.has(peerId);
  }

  /**
   * Mark peer as suspicious
   */
  markSuspicious(peerId: PeerId): void {
    this.suspiciousPeers.add(peerId);
  }

  /**
   * Mark peer as banned
   */
  markBanned(peerId: PeerId): void {
    this.bannedPeers.add(peerId);
  }

  /**
   * Unmark peer as suspicious
   */
  unmarkSuspicious(peerId: PeerId): void {
    this.suspiciousPeers.delete(peerId);
  }

  /**
   * Unban peer
   */
  unbanPeer(peerId: PeerId): void {
    this.bannedPeers.delete(peerId);
  }

  /**
   * Get suspicious peers
   */
  getSuspiciousPeers(): PeerId[] {
    return Array.from(this.suspiciousPeers);
  }

  /**
   * Get banned peers
   */
  getBannedPeers(): PeerId[] {
    return Array.from(this.bannedPeers);
  }

  /**
   * Get peer fingerprint
   */
  getFingerprint(peerId: PeerId): PeerFingerprint | null {
    return this.fingerprints.get(peerId) || null;
  }

  /**
   * Get all fingerprints
   */
  getAllFingerprints(): PeerFingerprint[] {
    return Array.from(this.fingerprints.values());
  }

  /**
   * Remove fingerprint
   */
  removeFingerprint(peerId: PeerId): boolean {
    return this.fingerprints.delete(peerId);
  }

  /**
   * Clear all fingerprints
   */
  clearAllFingerprints(): void {
    this.fingerprints.clear();
  }

  /**
   * Clear all fraud reports
   */
  clearAllFraudReports(): void {
    this.fraudReports.clear();
  }

  /**
   * Clear all suspicious marks
   */
  clearAllSuspicious(): void {
    this.suspiciousPeers.clear();
  }

  /**
   * Clear all bans
   */
  clearAllBans(): void {
    this.bannedPeers.clear();
  }

  /**
   * Get verification statistics
   */
  getStatistics(): {
    totalPeers: number;
    suspiciousPeers: number;
    bannedPeers: number;
    fraudReports: number;
    sybilDetections: number;
    averageConfidence: number;
  } {
    const fingerprints = Array.from(this.fingerprints.values());
    const sybilDetections = this.getFraudReportsByType('SYBIL').length;

    let totalConfidence = 0;
    let verifiedCount = 0;

    for (const peerId of this.fingerprints.keys()) {
      const result = this.verifyPeer(peerId);
      if (result.verified) {
        totalConfidence += result.confidence;
        verifiedCount++;
      }
    }

    const averageConfidence = verifiedCount > 0 ? totalConfidence / verifiedCount : 0;

    return {
      totalPeers: fingerprints.length,
      suspiciousPeers: this.suspiciousPeers.size,
      bannedPeers: this.bannedPeers.size,
      fraudReports: this.fraudReports.size,
      sybilDetections,
      averageConfidence,
    };
  }

  /**
   * Export fingerprints to JSON
   */
  exportFingerprintsToJSON(): string {
    return JSON.stringify(Array.from(this.fingerprints.values()), null, 2);
  }

  /**
   * Import fingerprints from JSON
   */
  importFingerprintsFromJSON(json: string): void {
    try {
      const fingerprints = JSON.parse(json) as PeerFingerprint[];
      for (const fingerprint of fingerprints) {
        this.fingerprints.set(fingerprint.peerId, fingerprint);
      }
    } catch (error) {
      console.error('[PeerVerification] Failed to import fingerprints from JSON:', error);
    }
  }

  /**
   * Export fraud reports to JSON
   */
  exportFraudReportsToJSON(): string {
    return JSON.stringify(Array.from(this.fraudReports.values()), null, 2);
  }

  /**
   * Import fraud reports from JSON
   */
  importFraudReportsFromJSON(json: string): void {
    try {
      const reports = JSON.parse(json) as FraudReport[];
      for (const report of reports) {
        this.fraudReports.set(report.reportId, report);
      }
    } catch (error) {
      console.error('[PeerVerification] Failed to import fraud reports from JSON:', error);
    }
  }
}
