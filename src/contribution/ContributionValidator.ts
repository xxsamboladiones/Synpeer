import type { PeerId } from '../network/NetworkTypes';
import type { ContributionMetrics, FraudDetectionResult } from './ContributionTypes';

/**
 * ContributionValidator detects fraudulent behavior
 */
export class ContributionValidator {
  private suspiciousPeers: Map<PeerId, FraudDetectionResult> = new Map();
  private peerActivity: Map<PeerId, number[]> = new Map(); // Timestamps of activity
  private peerChunkHashes: Map<PeerId, Set<string>> = new Map(); // Track chunk hashes served

  /**
   * Validate contribution metrics for fraud
   */
  validateMetrics(metrics: ContributionMetrics): FraudDetectionResult {
    const evidence: string[] = [];
    let fraudType: FraudDetectionResult['fraudType'] = null;
    let confidence = 0;

    // Check for unrealistic storage growth
    if (metrics.storageShared > 10 * 1024 * 1024 * 1024) {
      // 10GB in very short time
      evidence.push('Unrealistic storage growth rate');
      fraudType = 'FAKE_STORAGE';
      confidence += 30;
    }

    // Check for unrealistic bandwidth
    if (metrics.bandwidthShared > 100 * 1024 * 1024 * 1024) {
      // 100GB in very short time
      evidence.push('Unrealistic bandwidth usage');
      fraudType = 'FAKE_STORAGE';
      confidence += 30;
    }

    // Check for zero uptime but high contribution
    if (metrics.uptime < 60 && metrics.chunksServed > 100) {
      evidence.push('High contribution with zero uptime');
      fraudType = 'MANIPULATION';
      confidence += 50;
    }

    // Check for perfect success rate (suspicious)
    const totalRequests = metrics.requestsReceived;
    const successful = metrics.successfulUploads + metrics.successfulDownloads;
    if (totalRequests > 100 && successful === totalRequests) {
      evidence.push('Perfect success rate (suspicious)');
      fraudType = 'MANIPULATION';
      confidence += 20;
    }

    const isFraud = confidence > 50;

    return {
      isFraud,
      fraudType,
      confidence: Math.min(100, confidence),
      evidence,
      timestamp: Date.now(),
    };
  }

  /**
   * Detect Sybil attack (multiple fake peers from same source)
   */
  detectSybilAttack(peerId: PeerId, activityPattern: number[]): FraudDetectionResult {
    const evidence: string[] = [];
    let confidence = 0;

    // Check for bursty activity pattern (characteristic of Sybil)
    const recentActivity = activityPattern.filter((t) => Date.now() - t < 60000); // Last minute
    if (recentActivity.length > 100) {
      evidence.push('Bursty activity pattern detected');
      confidence += 40;
    }

    if (this.detectSynchronizedActivity()) {
      evidence.push('Synchronized activity with other peers');
      confidence += 60;
    }

    const isFraud = confidence > 50;

    const result: FraudDetectionResult = {
      isFraud,
      fraudType: isFraud ? 'SYBIL' : null,
      confidence: Math.min(100, confidence),
      evidence,
      timestamp: Date.now(),
    };

    if (isFraud) {
      this.suspiciousPeers.set(peerId, result);
    }

    return result;
  }

  /**
   * Detect data corruption
   */
  detectDataCorruption(
    peerId: PeerId,
    invalidDataCount: number,
    totalDataCount: number,
  ): FraudDetectionResult {
    const evidence: string[] = [];
    let confidence = 0;

    const corruptionRate = invalidDataCount / totalDataCount;

    if (corruptionRate > 0.1) {
      // More than 10% corruption
      evidence.push(`High corruption rate: ${(corruptionRate * 100).toFixed(2)}%`);
      confidence += 70;
    } else if (corruptionRate > 0.01) {
      // More than 1% corruption
      evidence.push(`Moderate corruption rate: ${(corruptionRate * 100).toFixed(2)}%`);
      confidence += 30;
    }

    const isFraud = confidence > 50;

    const result: FraudDetectionResult = {
      isFraud,
      fraudType: isFraud ? 'DATA_CORRUPTION' : null,
      confidence: Math.min(100, confidence),
      evidence,
      timestamp: Date.now(),
    };

    if (isFraud) {
      this.suspiciousPeers.set(peerId, result);
    }

    return result;
  }

  /**
   * Detect duplicate chunks (spamming)
   */
  detectDuplicateChunks(peerId: PeerId, chunkHash: string): FraudDetectionResult {
    if (!this.peerChunkHashes.has(peerId)) {
      this.peerChunkHashes.set(peerId, new Set());
    }

    const peerHashes = this.peerChunkHashes.get(peerId)!;

    if (peerHashes.has(chunkHash)) {
      const evidence = [`Duplicate chunk served: ${chunkHash}`];
      const result: FraudDetectionResult = {
        isFraud: true,
        fraudType: 'DUPLICATE_CHUNKS',
        confidence: 80,
        evidence,
        timestamp: Date.now(),
      };

      this.suspiciousPeers.set(peerId, result);
      return result;
    }

    peerHashes.add(chunkHash);

    return {
      isFraud: false,
      fraudType: null,
      confidence: 0,
      evidence: [],
      timestamp: Date.now(),
    };
  }

  /**
   * Detect fake ping responses
   */
  detectFakePing(
    peerId: PeerId,
    responseTime: number,
    expectedRange: [number, number],
  ): FraudDetectionResult {
    const [minTime, maxTime] = expectedRange;
    const evidence: string[] = [];
    let confidence = 0;

    if (responseTime < minTime) {
      evidence.push(`Response time too fast: ${responseTime}ms (expected > ${minTime}ms)`);
      confidence += 60;
    } else if (responseTime > maxTime) {
      evidence.push(`Response time too slow: ${responseTime}ms (expected < ${maxTime}ms)`);
      confidence += 20;
    }

    const isFraud = confidence > 50;

    const result: FraudDetectionResult = {
      isFraud,
      fraudType: isFraud ? 'FAKE_PING' : null,
      confidence: Math.min(100, confidence),
      evidence,
      timestamp: Date.now(),
    };

    if (isFraud) {
      this.suspiciousPeers.set(peerId, result);
    }

    return result;
  }

  /**
   * Track peer activity
   */
  trackActivity(peerId: PeerId): void {
    if (!this.peerActivity.has(peerId)) {
      this.peerActivity.set(peerId, []);
    }

    const activity = this.peerActivity.get(peerId)!;
    activity.push(Date.now());

    // Keep only last 1000 activity timestamps
    if (activity.length > 1000) {
      activity.shift();
    }
  }

  /**
   * Get suspicious peers
   */
  getSuspiciousPeers(): Map<PeerId, FraudDetectionResult> {
    return new Map(this.suspiciousPeers);
  }

  /**
   * Check if peer is suspicious
   */
  isPeerSuspicious(peerId: PeerId): boolean {
    return this.suspiciousPeers.has(peerId);
  }

  /**
   * Get fraud detection result for peer
   */
  getFraudResult(peerId: PeerId): FraudDetectionResult | null {
    return this.suspiciousPeers.get(peerId) || null;
  }

  /**
   * Clear peer from suspicious list
   */
  clearSuspiciousPeer(peerId: PeerId): void {
    this.suspiciousPeers.delete(peerId);
  }

  /**
   * Clear all suspicious peers
   */
  clearAllSuspicious(): void {
    this.suspiciousPeers.clear();
  }

  /**
   * Detect synchronized activity (helper for Sybil detection)
   */
  private detectSynchronizedActivity(): boolean {
    const peerWindows = Array.from(this.peerActivity.values()).map((timestamps) =>
      timestamps
        .filter((timestamp) => Date.now() - timestamp < 60000)
        .map((timestamp) => Math.floor(timestamp / 5000)),
    );

    for (let first = 0; first < peerWindows.length; first += 1) {
      const firstWindow = new Set(peerWindows[first]);
      if (firstWindow.size < 3) {
        continue;
      }

      for (let second = first + 1; second < peerWindows.length; second += 1) {
        const secondWindow = new Set(peerWindows[second]);
        let overlap = 0;
        for (const bucket of firstWindow) {
          if (secondWindow.has(bucket)) {
            overlap += 1;
          }
        }

        if (overlap >= 3 && overlap / Math.min(firstWindow.size, secondWindow.size) >= 0.8) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Calculate fraud score (0-100, higher = more suspicious)
   */
  calculateFraudScore(peerId: PeerId): number {
    const result = this.suspiciousPeers.get(peerId);
    if (!result) {
      return 0;
    }
    return result.confidence;
  }

  /**
   * Get fraud statistics
   */
  getFraudStatistics(): {
    totalSuspicious: number;
    byType: Map<string, number>;
    averageConfidence: number;
  } {
    const results = Array.from(this.suspiciousPeers.values());
    const byType = new Map<string, number>();

    for (const result of results) {
      if (result.fraudType) {
        const count = byType.get(result.fraudType) || 0;
        byType.set(result.fraudType, count + 1);
      }
    }

    const averageConfidence =
      results.length > 0 ? results.reduce((sum, r) => sum + r.confidence, 0) / results.length : 0;

    return {
      totalSuspicious: results.length,
      byType,
      averageConfidence,
    };
  }
}
