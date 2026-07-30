import type { PeerId } from '../network/NetworkTypes';
import type { ProofBundle, ContributionProof, Signature } from './ConsensusTypes';
import { defaultConsensusConfig } from './ConsensusTypes';

/**
 * Proof Bundle Manager handles bundle creation and validation
 */
export class ProofBundleManager {
  private bundles: Map<string, ProofBundle> = new Map();
  private pendingProofs: Map<string, ContributionProof> = new Map();
  private config = defaultConsensusConfig;

  /**
   * Create a proof bundle from contributions
   */
  createBundle(
    creator: PeerId,
    contributions: ContributionProof[],
    trustScore: number,
    signature: Signature,
  ): ProofBundle | null {
    // Validate contributions
    for (const proof of contributions) {
      if (!this.validateContributionProof(proof)) {
        console.error('[ProofBundleManager] Invalid contribution proof:', proof.contributionId);
        return null;
      }
    }

    // Check bundle size limits
    if (contributions.length > this.config.maxContributionsPerBundle) {
      console.error('[ProofBundleManager] Too many contributions in bundle');
      return null;
    }

    // Calculate total value
    const totalValue = contributions.reduce((sum, proof) => sum + proof.value, 0);

    // Create bundle
    const bundleId = `bundle_${creator}_${Date.now()}`;
    const bundle: ProofBundle = {
      version: this.config.protocolVersion,
      bundleId,
      creator,
      timestamp: Date.now(),
      contributions,
      totalValue,
      trustScore,
      hash: this.calculateBundleHash(
        bundleId,
        creator,
        Date.now(),
        contributions,
        totalValue,
        trustScore,
      ),
      signature: signature.signature,
    };

    this.bundles.set(bundleId, bundle);
    return bundle;
  }

  /**
   * Validate a proof bundle
   */
  validateBundle(bundle: ProofBundle): boolean {
    // Check version
    if (bundle.version !== this.config.protocolVersion) {
      return false;
    }

    // Check timestamp (within 1 hour)
    const timestampAge = Date.now() - bundle.timestamp;
    if (timestampAge > 60 * 60 * 1000) {
      return false;
    }

    // Check contribution count
    if (bundle.contributions.length > this.config.maxContributionsPerBundle) {
      return false;
    }

    // Validate all contributions
    for (const proof of bundle.contributions) {
      if (!this.validateContributionProof(proof)) {
        return false;
      }
    }

    // Check total value
    const calculatedTotal = bundle.contributions.reduce((sum, proof) => sum + proof.value, 0);
    if (calculatedTotal !== bundle.totalValue) {
      return false;
    }

    // Check hash
    const calculatedHash = this.calculateBundleHash(
      bundle.bundleId,
      bundle.creator,
      bundle.timestamp,
      bundle.contributions,
      bundle.totalValue,
      bundle.trustScore,
    );
    if (calculatedHash !== bundle.hash) {
      return false;
    }

    // Check signature
    if (!this.validateSignature(bundle.signature, bundle.creator)) {
      return false;
    }

    return true;
  }

  /**
   * Validate contribution proof
   */
  private validateContributionProof(proof: ContributionProof): boolean {
    // Check if quorum was reached
    if (!proof.quorumReached) {
      return false;
    }

    // Check approval percentage
    if (proof.approvalPercentage < 66) {
      return false;
    }

    // Check if evidence is valid
    if (!proof.evidence || !proof.evidence.hash) {
      return false;
    }

    // Check if votes are present
    if (!proof.votes || proof.votes.length === 0) {
      return false;
    }

    return true;
  }

  /**
   * Validate signature
   */
  private validateSignature(signature: string, peerId: PeerId): boolean {
    // Simple validation - in production, use Ed25519 verification
    return signature.length > 0 && peerId.length > 0;
  }

  /**
   * Calculate bundle hash
   */
  private calculateBundleHash(
    bundleId: string,
    creator: PeerId,
    timestamp: number,
    contributions: ContributionProof[],
    totalValue: number,
    trustScore: number,
  ): string {
    // Sort contribution hashes for deterministic hash
    const contributionHashes = contributions
      .map((c) => c.hash)
      .sort()
      .join('');

    const data = `${bundleId}${creator}${timestamp}${contributionHashes}${totalValue}${trustScore}`;

    // Simple hash for now - in production, use SHA-256
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Get bundle by ID
   */
  getBundle(bundleId: string): ProofBundle | null {
    return this.bundles.get(bundleId) || null;
  }

  /**
   * Get bundles by creator
   */
  getBundlesByCreator(creator: PeerId): ProofBundle[] {
    return Array.from(this.bundles.values()).filter((b) => b.creator === creator);
  }

  /**
   * Get all bundles
   */
  getAllBundles(): ProofBundle[] {
    return Array.from(this.bundles.values());
  }

  /**
   * Get recent bundles
   */
  getRecentBundles(hours: number = 24): ProofBundle[] {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    return Array.from(this.bundles.values()).filter((b) => b.timestamp >= cutoff);
  }

  /**
   * Add pending proof
   */
  addPendingProof(proof: ContributionProof): void {
    this.pendingProofs.set(proof.contributionId, proof);
  }

  /**
   * Get pending proof
   */
  getPendingProof(contributionId: string): ContributionProof | null {
    return this.pendingProofs.get(contributionId) || null;
  }

  /**
   * Get all pending proofs
   */
  getAllPendingProofs(): ContributionProof[] {
    return Array.from(this.pendingProofs.values());
  }

  /**
   * Remove pending proof
   */
  removePendingProof(contributionId: string): boolean {
    return this.pendingProofs.delete(contributionId);
  }

  /**
   * Clear all pending proofs
   */
  clearPendingProofs(): void {
    this.pendingProofs.clear();
  }

  /**
   * Remove bundle
   */
  removeBundle(bundleId: string): boolean {
    return this.bundles.delete(bundleId);
  }

  /**
   * Clear all bundles
   */
  clearAllBundles(): void {
    this.bundles.clear();
  }

  /**
   * Get bundle count
   */
  getBundleCount(): number {
    return this.bundles.size;
  }

  /**
   * Get pending proof count
   */
  getPendingProofCount(): number {
    return this.pendingProofs.size;
  }

  /**
   * Get statistics
   */
  getStatistics(): {
    totalBundles: number;
    pendingProofs: number;
    totalContributions: number;
    totalValue: number;
    averageTrustScore: number;
    byCreator: Map<PeerId, number>;
  } {
    const bundles = Array.from(this.bundles.values());
    const totalBundles = bundles.length;
    const pendingProofs = this.pendingProofs.size;

    const totalContributions = bundles.reduce((sum, b) => sum + b.contributions.length, 0);
    const totalValue = bundles.reduce((sum, b) => sum + b.totalValue, 0);

    const averageTrustScore =
      totalBundles > 0 ? bundles.reduce((sum, b) => sum + b.trustScore, 0) / totalBundles : 0;

    const byCreator = new Map<PeerId, number>();
    for (const bundle of bundles) {
      const count = byCreator.get(bundle.creator) || 0;
      byCreator.set(bundle.creator, count + 1);
    }

    return {
      totalBundles,
      pendingProofs,
      totalContributions,
      totalValue,
      averageTrustScore,
      byCreator,
    };
  }

  /**
   * Export bundles to JSON
   */
  exportToJSON(): string {
    return JSON.stringify(Array.from(this.bundles.values()), null, 2);
  }

  /**
   * Import bundles from JSON
   */
  importFromJSON(json: string): void {
    try {
      const bundles = JSON.parse(json) as ProofBundle[];
      for (const bundle of bundles) {
        if (this.validateBundle(bundle)) {
          this.bundles.set(bundle.bundleId, bundle);
        }
      }
    } catch (error) {
      console.error('[ProofBundleManager] Failed to import from JSON:', error);
    }
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<typeof defaultConsensusConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
  }

  /**
   * Get configuration
   */
  getConfig(): typeof defaultConsensusConfig {
    return { ...this.config };
  }
}
