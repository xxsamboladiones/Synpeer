import type { PeerId } from '../../network/NetworkTypes';
import * as ed25519 from '@noble/ed25519';
import { encodeUtf8 } from '../../utils/hash';

export interface SignedData {
  data: string;
  signature: string;
  publicKey: string;
  timestamp: number;
}

export interface VerificationResult {
  valid: boolean;
  peerId: PeerId;
  timestamp: number;
  error?: string;
}

/**
 * SignatureVerificationService verifies signatures for all received content
 * Ensures authenticity and integrity of data
 */
export class SignatureVerificationService {
  private verificationHistory: Map<string, VerificationResult>;

  constructor() {
    this.verificationHistory = new Map();
  }

  /**
   * Verify signature of signed data using Ed25519
   */
  async verify(signedData: SignedData, peerId: PeerId): Promise<VerificationResult> {
    const result: VerificationResult = {
      valid: false,
      peerId,
      timestamp: Date.now(),
    };

    try {
      // Convert data to bytes
      const messageBytes = encodeUtf8(signedData.data);

      // Convert signature from hex string to bytes
      const signatureBytes = this.hexToBytes(signedData.signature);

      // Convert public key from hex string to bytes
      const publicKeyBytes = this.hexToBytes(signedData.publicKey);

      // Verify signature using Ed25519
      const isValid = await ed25519.verify(signatureBytes, messageBytes, publicKeyBytes);

      result.valid = isValid;

      if (!isValid) {
        result.error = 'Invalid Ed25519 signature';
      }

      // Store verification result
      const historyKey = `${peerId}_${signedData.timestamp}_${signedData.signature.substring(0, 16)}`;
      this.verificationHistory.set(historyKey, result);

      return result;
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Unknown error';
      console.error('[SignatureVerificationService] Verification failed:', error);
      return result;
    }
  }

  /**
   * Convert hex string to bytes
   */
  private hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  /**
   * Verify batch of signed data
   */
  async verifyBatch(
    items: Array<{ data: SignedData; peerId: PeerId }>,
  ): Promise<VerificationResult[]> {
    const results = await Promise.all(items.map((item) => this.verify(item.data, item.peerId)));
    return results;
  }

  /**
   * Check if data was already verified
   */
  wasVerified(peerId: PeerId, timestamp: number, signature: string): boolean {
    const historyKey = `${peerId}_${timestamp}_${signature.substring(0, 16)}`;
    return this.verificationHistory.has(historyKey);
  }

  /**
   * Get verification result
   */
  getVerificationResult(
    peerId: PeerId,
    timestamp: number,
    signature: string,
  ): VerificationResult | undefined {
    const historyKey = `${peerId}_${timestamp}_${signature.substring(0, 16)}`;
    return this.verificationHistory.get(historyKey);
  }

  /**
   * Get verification statistics
   */
  getStatistics(): { total: number; valid: number; invalid: number } {
    const results = Array.from(this.verificationHistory.values());
    return {
      total: results.length,
      valid: results.filter((r) => r.valid).length,
      invalid: results.filter((r) => !r.valid).length,
    };
  }

  /**
   * Clean old verification history (older than 24 hours)
   */
  cleanOldHistory(threshold: number = 86400000): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, result] of this.verificationHistory.entries()) {
      if (now - result.timestamp > threshold) {
        this.verificationHistory.delete(key);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Clear verification history
   */
  clearHistory(): void {
    this.verificationHistory.clear();
  }
}
