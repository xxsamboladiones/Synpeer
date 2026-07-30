import { sha256Hex, toBytes } from '../utils/hash';

/**
 * CIDGenerator generates Content Identifiers (CIDs)
 * Uses SHA256 hash + Base58 encoding for deterministic IDs
 * Ensures all peers generate the same ID for the same content
 */
export class CIDGenerator {
  /**
   * Generate CID from content
   * Format: SHA256(content) -> Base58
   */
  static async generateCID(content: string | Uint8Array): Promise<string> {
    try {
      const contentBytes = toBytes(content);
      const hash = sha256Hex(contentBytes);

      // Convert hex to bytes
      const hashBytes = this.hexToBytes(hash);

      // Encode to Base58
      const cid = this.base58Encode(hashBytes);

      return cid;
    } catch (error) {
      console.error('[CIDGenerator] Failed to generate CID:', error);
      throw error;
    }
  }

  /**
   * Generate CID for post
   * Includes author, timestamp, and content hash
   */
  static async generatePostCID(
    authorPublicKey: string,
    timestamp: number,
    content: string,
  ): Promise<string> {
    const combined = `${authorPublicKey}_${timestamp}_${content}`;
    return await this.generateCID(combined);
  }

  /**
   * Generate CID for media
   * Includes content hash and metadata
   */
  static async generateMediaCID(
    contentHash: string,
    mimeType: string,
    size: number,
  ): Promise<string> {
    const combined = `${contentHash}_${mimeType}_${size}`;
    return await this.generateCID(combined);
  }

  /**
   * Generate CID for transaction
   * Includes sender, receiver, amount, timestamp, and nonce
   */
  static async generateTransactionCID(
    senderPublicKey: string,
    receiverPublicKey: string,
    amount: number,
    timestamp: number,
    nonce: string,
  ): Promise<string> {
    const combined = `${senderPublicKey}_${receiverPublicKey}_${amount}_${timestamp}_${nonce}`;
    return await this.generateCID(combined);
  }

  /**
   * Generate CID for chunk
   * Includes media object ID and position
   */
  static async generateChunkCID(
    mediaObjectId: string,
    position: number,
    chunkData: Uint8Array,
  ): Promise<string> {
    const combined = `${mediaObjectId}_${position}_${Array.from(chunkData).join(',')}`;
    return await this.generateCID(combined);
  }

  /**
   * Generate CID for evidence
   * Includes type, data, and timestamp
   */
  static async generateEvidenceCID(type: string, data: string, timestamp: number): Promise<string> {
    const combined = `${type}_${data}_${timestamp}`;
    return await this.generateCID(combined);
  }

  /**
   * Generate CID for ledger entry
   * Includes transaction CID and block number
   */
  static async generateLedgerEntryCID(
    transactionCID: string,
    blockNumber: number,
  ): Promise<string> {
    const combined = `${transactionCID}_${blockNumber}`;
    return await this.generateCID(combined);
  }

  /**
   * Convert hex string to bytes
   */
  private static hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  /**
   * Encode bytes to Base58
   * Base58 alphabet: 123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
   */
  private static base58Encode(bytes: Uint8Array): string {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const digits = [0];

    for (let i = 0; i < bytes.length; i++) {
      let carry = bytes[i];
      for (let j = 0; j < digits.length; j++) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }

      while (carry > 0) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }

    let result = '';
    for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
      result += '1';
    }

    for (let i = digits.length - 1; i >= 0; i--) {
      result += alphabet[digits[i]];
    }

    return result;
  }

  /**
   * Validate CID format
   */
  static isValidCID(cid: string): boolean {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    if (cid.length === 0) return false;

    for (const char of cid) {
      if (!alphabet.includes(char)) {
        return false;
      }
    }

    return true;
  }
}
