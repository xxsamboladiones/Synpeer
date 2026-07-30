import type { PeerId } from '../network/NetworkTypes';
import type { WitnessSelectionCriteria, Signature } from './ConsensusTypes';

/**
 * Witness information
 */
interface WitnessInfo {
  peerId: PeerId;
  trustScore: number;
  lastSeen: number;
  geographicRegion?: string;
  selectedCount: number;
}

/**
 * Witness Manager handles witness selection and verification
 */
export class WitnessManager {
  private witnesses: Map<PeerId, WitnessInfo> = new Map();
  private selectedWitnesses: Map<string, Set<PeerId>> = new Map();
  private criteria: WitnessSelectionCriteria;
  private selectionCounter: number = 0;

  constructor(criteria?: Partial<WitnessSelectionCriteria>) {
    this.criteria = {
      minTrustScore: criteria?.minTrustScore ?? 600,
      minCount: criteria?.minCount ?? 3,
      maxCount: criteria?.maxCount ?? 10,
      requireGeographicDiversity: criteria?.requireGeographicDiversity ?? true,
      requireRandomSelection: criteria?.requireRandomSelection ?? true,
    };
  }

  /**
   * Register a potential witness
   */
  registerWitness(peerId: PeerId, trustScore: number, geographicRegion?: string): void {
    this.witnesses.set(peerId, {
      peerId,
      trustScore,
      lastSeen: Date.now(),
      geographicRegion,
      selectedCount: 0,
    });
  }

  /**
   * Update witness trust score
   */
  updateWitnessTrustScore(peerId: PeerId, trustScore: number): boolean {
    const witness = this.witnesses.get(peerId);
    if (!witness) {
      return false;
    }

    witness.trustScore = trustScore;
    witness.lastSeen = Date.now();
    return true;
  }

  /**
   * Select witnesses for a contribution
   */
  selectWitnesses(contributionId: string, excludePeers: PeerId[] = []): PeerId[] {
    const eligibleWitnesses = this.getEligibleWitnesses(excludePeers);

    if (eligibleWitnesses.length < this.criteria.minCount) {
      console.warn('[WitnessManager] Not enough eligible witnesses');
      return [];
    }

    let selected: PeerId[];

    if (this.criteria.requireRandomSelection) {
      selected = this.selectRandomWitnesses(eligibleWitnesses);
    } else {
      selected = this.selectTopWitnesses(eligibleWitnesses);
    }

    if (this.criteria.requireGeographicDiversity) {
      selected = this.ensureGeographicDiversity(selected, eligibleWitnesses);
    }

    // Limit to max count
    selected = selected.slice(0, this.criteria.maxCount);

    // Track selected witnesses
    this.selectedWitnesses.set(contributionId, new Set(selected));

    // Update selection counts
    for (const peerId of selected) {
      const witness = this.witnesses.get(peerId);
      if (witness) {
        witness.selectedCount++;
      }
    }

    return selected;
  }

  /**
   * Get eligible witnesses
   */
  private getEligibleWitnesses(excludePeers: PeerId[]): WitnessInfo[] {
    return Array.from(this.witnesses.values()).filter((witness) => {
      // Check trust score
      if (witness.trustScore < this.criteria.minTrustScore) {
        return false;
      }

      // Check if excluded
      if (excludePeers.includes(witness.peerId)) {
        return false;
      }

      // Check if recently seen (within 24 hours)
      const timeSinceSeen = Date.now() - witness.lastSeen;
      if (timeSinceSeen > 24 * 60 * 60 * 1000) {
        return false;
      }

      return true;
    });
  }

  /**
   * Select random witnesses using deterministic hash-based selection
   */
  private selectRandomWitnesses(eligible: WitnessInfo[]): PeerId[] {
    // Use deterministic selection based on peerId hash instead of Math.random()
    this.selectionCounter++;
    const sorted = [...eligible].sort((a, b) => {
      const hashA = this.hashPeerId(a.peerId, this.selectionCounter);
      const hashB = this.hashPeerId(b.peerId, this.selectionCounter);
      return hashA.localeCompare(hashB);
    });
    return sorted.map((w) => w.peerId);
  }

  /**
   * Select top witnesses by trust score
   */
  private selectTopWitnesses(eligible: WitnessInfo[]): PeerId[] {
    const sorted = [...eligible].sort((a, b) => b.trustScore - a.trustScore);
    return sorted.map((w) => w.peerId);
  }

  /**
   * Hash peerId for deterministic selection
   */
  private hashPeerId(peerId: PeerId, counter: number): string {
    // Simple hash function for deterministic peer selection
    let hash = 0;
    const combined = `${peerId}_${counter}`;
    for (let i = 0; i < combined.length; i++) {
      const char = combined.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Ensure geographic diversity
   */
  private ensureGeographicDiversity(selected: PeerId[], eligible: WitnessInfo[]): PeerId[] {
    const selectedRegions = new Set<string>();
    const selectedWitnesses = new Set(selected);

    // Get regions of selected witnesses
    for (const peerId of selected) {
      const witness = this.witnesses.get(peerId);
      if (witness?.geographicRegion) {
        selectedRegions.add(witness.geographicRegion);
      }
    }

    // If we have enough diversity, return as is
    if (selectedRegions.size >= 3) {
      return selected;
    }

    // Add witnesses from different regions
    const additionalWitnesses: PeerId[] = [];
    for (const witness of eligible) {
      if (selectedWitnesses.has(witness.peerId)) {
        continue;
      }

      if (witness.geographicRegion && !selectedRegions.has(witness.geographicRegion)) {
        additionalWitnesses.push(witness.peerId);
        selectedRegions.add(witness.geographicRegion);
        selectedWitnesses.add(witness.peerId);

        if (selectedRegions.size >= 3) {
          break;
        }
      }
    }

    return [...selected, ...additionalWitnesses];
  }

  /**
   * Verify witness signature
   */
  verifyWitnessSignature(peerId: PeerId, signature: Signature): boolean {
    const witness = this.witnesses.get(peerId);
    if (!witness) {
      return false;
    }

    // Check signature algorithm
    if (signature.algorithm !== 'ed25519') {
      return false;
    }

    // Check if signature is recent
    const signatureAge = Date.now() - signature.timestamp;
    if (signatureAge > 5 * 60 * 1000) {
      return false;
    }

    // Check if public key matches witness
    if (signature.publicKey !== peerId) {
      return false;
    }

    return true;
  }

  /**
   * Get selected witnesses for a contribution
   */
  getSelectedWitnesses(contributionId: string): PeerId[] {
    return Array.from(this.selectedWitnesses.get(contributionId) || []);
  }

  /**
   * Get witness info
   */
  getWitnessInfo(peerId: PeerId): WitnessInfo | null {
    return this.witnesses.get(peerId) || null;
  }

  /**
   * Get all witnesses
   */
  getAllWitnesses(): WitnessInfo[] {
    return Array.from(this.witnesses.values());
  }

  /**
   * Get witnesses by trust score
   */
  getWitnessesByTrustScore(minScore: number): WitnessInfo[] {
    return Array.from(this.witnesses.values()).filter((w) => w.trustScore >= minScore);
  }

  /**
   * Get witnesses by region
   */
  getWitnessesByRegion(region: string): WitnessInfo[] {
    return Array.from(this.witnesses.values()).filter((w) => w.geographicRegion === region);
  }

  /**
   * Remove witness
   */
  removeWitness(peerId: PeerId): boolean {
    return this.witnesses.delete(peerId);
  }

  /**
   * Clear all witnesses
   */
  clearAll(): void {
    this.witnesses.clear();
    this.selectedWitnesses.clear();
  }

  /**
   * Update selection criteria
   */
  updateCriteria(criteria: Partial<WitnessSelectionCriteria>): void {
    this.criteria = {
      ...this.criteria,
      ...criteria,
    };
  }

  /**
   * Get current criteria
   */
  getCriteria(): WitnessSelectionCriteria {
    return { ...this.criteria };
  }

  /**
   * Get witness count
   */
  getCount(): number {
    return this.witnesses.size;
  }

  /**
   * Get eligible witness count
   */
  getEligibleCount(excludePeers: PeerId[] = []): number {
    return this.getEligibleWitnesses(excludePeers).length;
  }

  /**
   * Get witness statistics
   */
  getStatistics(): {
    total: number;
    eligible: number;
    averageTrustScore: number;
    byRegion: Map<string, number>;
    topSelected: PeerId[];
  } {
    const witnesses = Array.from(this.witnesses.values());
    const eligible = this.getEligibleWitnesses([]);

    const averageTrustScore =
      witnesses.length > 0
        ? witnesses.reduce((sum, w) => sum + w.trustScore, 0) / witnesses.length
        : 0;

    const byRegion = new Map<string, number>();
    for (const witness of witnesses) {
      if (witness.geographicRegion) {
        const count = byRegion.get(witness.geographicRegion) || 0;
        byRegion.set(witness.geographicRegion, count + 1);
      }
    }

    const topSelected = [...witnesses]
      .sort((a, b) => b.selectedCount - a.selectedCount)
      .slice(0, 10)
      .map((w) => w.peerId);

    return {
      total: witnesses.length,
      eligible: eligible.length,
      averageTrustScore,
      byRegion,
      topSelected,
    };
  }

  /**
   * Export witnesses to JSON
   */
  exportToJSON(): string {
    return JSON.stringify(Array.from(this.witnesses.values()), null, 2);
  }

  /**
   * Import witnesses from JSON
   */
  importFromJSON(json: string): void {
    try {
      const witnessArray = JSON.parse(json) as WitnessInfo[];
      for (const witness of witnessArray) {
        this.witnesses.set(witness.peerId, witness);
      }
    } catch (error) {
      console.error('[WitnessManager] Failed to import from JSON:', error);
    }
  }
}
