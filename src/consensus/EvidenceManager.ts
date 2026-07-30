import type { PeerId } from '../network/NetworkTypes';
import type { ContributionEvidence, ContributionType, Signature } from './ConsensusTypes';

/**
 * Evidence Manager handles evidence collection and validation
 */
export class EvidenceManager {
  private evidence: Map<string, ContributionEvidence> = new Map();
  private pendingEvidence: Map<string, ContributionEvidence> = new Map();
  private validatedEvidence: Map<string, ContributionEvidence> = new Map();

  /**
   * Create evidence for a contribution
   */
  createEvidence(
    contributionId: string,
    contributor: PeerId,
    type: ContributionType,
    value: number,
    chunkId?: string,
    recipient?: PeerId,
  ): ContributionEvidence {
    const evidence: ContributionEvidence = {
      contributionId,
      contributor,
      type,
      value,
      timestamp: Date.now(),
      chunkId,
      recipient,
      witnesses: [],
      signatures: [],
      hash: this.calculateEvidenceHash(contributionId, contributor, type, value, Date.now()),
    };

    this.pendingEvidence.set(evidence.hash, evidence);
    return evidence;
  }

  /**
   * Add witness to evidence
   */
  addWitness(evidenceHash: string, witness: PeerId): boolean {
    const evidence = this.pendingEvidence.get(evidenceHash);
    if (!evidence) {
      return false;
    }

    if (evidence.witnesses.includes(witness)) {
      return false;
    }

    evidence.witnesses.push(witness);
    return true;
  }

  /**
   * Add signature to evidence
   */
  addSignature(evidenceHash: string, signature: Signature): boolean {
    const evidence = this.pendingEvidence.get(evidenceHash);
    if (!evidence) {
      return false;
    }

    evidence.signatures.push(signature);
    return true;
  }

  /**
   * Validate evidence
   */
  validateEvidence(evidence: ContributionEvidence): boolean {
    // Check if hash matches
    const calculatedHash = this.calculateEvidenceHash(
      evidence.contributionId,
      evidence.contributor,
      evidence.type,
      evidence.value,
      evidence.timestamp,
    );

    if (calculatedHash !== evidence.hash) {
      return false;
    }

    // Check if timestamp is recent (within 5 minutes)
    const timestampAge = Date.now() - evidence.timestamp;
    if (timestampAge > 5 * 60 * 1000) {
      return false;
    }

    // Check if there are witnesses
    if (evidence.witnesses.length === 0) {
      return false;
    }

    // Check if there are signatures
    if (evidence.signatures.length === 0) {
      return false;
    }

    // Validate all signatures
    for (const signature of evidence.signatures) {
      if (!this.validateSignature(signature)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Validate signature
   */
  private validateSignature(signature: Signature): boolean {
    // Check signature algorithm
    if (signature.algorithm !== 'ed25519') {
      return false;
    }

    // Check if signature is recent
    const signatureAge = Date.now() - signature.timestamp;
    if (signatureAge > 5 * 60 * 1000) {
      return false;
    }

    // Check if public key is present
    if (!signature.publicKey || signature.publicKey.length === 0) {
      return false;
    }

    // Check if signature is present
    if (!signature.signature || signature.signature.length === 0) {
      return false;
    }

    return true;
  }

  /**
   * Submit evidence for validation
   */
  submitEvidence(evidence: ContributionEvidence): boolean {
    if (!this.validateEvidence(evidence)) {
      return false;
    }

    // Move from pending to validated
    this.pendingEvidence.delete(evidence.hash);
    this.validatedEvidence.set(evidence.hash, evidence);
    this.evidence.set(evidence.hash, evidence);

    return true;
  }

  /**
   * Get evidence by hash
   */
  getEvidence(evidenceHash: string): ContributionEvidence | null {
    return this.evidence.get(evidenceHash) || null;
  }

  /**
   * Get evidence by contribution ID
   */
  getEvidenceByContributionId(contributionId: string): ContributionEvidence[] {
    return Array.from(this.evidence.values()).filter((e) => e.contributionId === contributionId);
  }

  /**
   * Get evidence by contributor
   */
  getEvidenceByContributor(contributor: PeerId): ContributionEvidence[] {
    return Array.from(this.evidence.values()).filter((e) => e.contributor === contributor);
  }

  /**
   * Get evidence by type
   */
  getEvidenceByType(type: ContributionType): ContributionEvidence[] {
    return Array.from(this.evidence.values()).filter((e) => e.type === type);
  }

  /**
   * Get pending evidence
   */
  getPendingEvidence(): ContributionEvidence[] {
    return Array.from(this.pendingEvidence.values());
  }

  /**
   * Get validated evidence
   */
  getValidatedEvidence(): ContributionEvidence[] {
    return Array.from(this.validatedEvidence.values());
  }

  /**
   * Get all evidence
   */
  getAllEvidence(): ContributionEvidence[] {
    return Array.from(this.evidence.values());
  }

  /**
   * Calculate evidence hash
   */
  private calculateEvidenceHash(
    contributionId: string,
    contributor: PeerId,
    type: ContributionType,
    value: number,
    timestamp: number,
  ): string {
    const data = `${contributionId}${contributor}${type}${value}${timestamp}`;
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
   * Delete evidence
   */
  deleteEvidence(evidenceHash: string): boolean {
    const deleted = this.evidence.delete(evidenceHash);
    this.pendingEvidence.delete(evidenceHash);
    this.validatedEvidence.delete(evidenceHash);
    return deleted;
  }

  /**
   * Delete evidence by contribution ID
   */
  deleteEvidenceByContributionId(contributionId: string): number {
    let count = 0;
    for (const [hash, evidence] of this.evidence.entries()) {
      if (evidence.contributionId === contributionId) {
        this.deleteEvidence(hash);
        count++;
      }
    }
    return count;
  }

  /**
   * Clear all evidence
   */
  clearAll(): void {
    this.evidence.clear();
    this.pendingEvidence.clear();
    this.validatedEvidence.clear();
  }

  /**
   * Get evidence count
   */
  getCount(): number {
    return this.evidence.size;
  }

  /**
   * Get pending evidence count
   */
  getPendingCount(): number {
    return this.pendingEvidence.size;
  }

  /**
   * Get validated evidence count
   */
  getValidatedCount(): number {
    return this.validatedEvidence.size;
  }

  /**
   * Export evidence to JSON
   */
  exportToJSON(): string {
    return JSON.stringify(Array.from(this.evidence.values()), null, 2);
  }

  /**
   * Import evidence from JSON
   */
  importFromJSON(json: string): void {
    try {
      const evidenceArray = JSON.parse(json) as ContributionEvidence[];
      for (const evidence of evidenceArray) {
        if (this.validateEvidence(evidence)) {
          this.evidence.set(evidence.hash, evidence);
          this.validatedEvidence.set(evidence.hash, evidence);
        }
      }
    } catch (error) {
      console.error('[EvidenceManager] Failed to import from JSON:', error);
    }
  }

  /**
   * Get evidence statistics
   */
  getStatistics(): {
    total: number;
    pending: number;
    validated: number;
    byType: Map<ContributionType, number>;
    byContributor: Map<PeerId, number>;
  } {
    const byType = new Map<ContributionType, number>();
    const byContributor = new Map<PeerId, number>();

    for (const evidence of this.evidence.values()) {
      const typeCount = byType.get(evidence.type) || 0;
      byType.set(evidence.type, typeCount + 1);

      const contributorCount = byContributor.get(evidence.contributor) || 0;
      byContributor.set(evidence.contributor, contributorCount + 1);
    }

    return {
      total: this.evidence.size,
      pending: this.pendingEvidence.size,
      validated: this.validatedEvidence.size,
      byType,
      byContributor,
    };
  }
}
