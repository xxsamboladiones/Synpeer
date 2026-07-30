import type { PeerId } from '../../network/NetworkTypes';
import * as Crypto from 'expo-crypto';

export interface MessageMetadata {
  messageId: string;
  nonce: string;
  timestamp: number;
  peerId: PeerId;
}

export interface ReplayConfig {
  maxAge: number; // Maximum age of a valid message in milliseconds
  cleanupInterval: number; // Interval for cleaning old messages
}

/**
 * ReplayProtectionService protects against replay attacks
 * Tracks message IDs, nonces, and timestamps to prevent duplicate messages
 */
export class ReplayProtectionService {
  private config: ReplayConfig;
  private messageHistory: Map<string, MessageMetadata>;
  private nonceHistory: Map<string, number>;
  private cleanupInterval: ReturnType<typeof globalThis.setInterval> | null = null;
  private isRunning: boolean = false;

  constructor(config: ReplayConfig) {
    this.config = {
      maxAge: config.maxAge ?? 300000,
      cleanupInterval: config.cleanupInterval ?? 60000,
    };
    this.messageHistory = new Map();
    this.nonceHistory = new Map();
  }

  /**
   * Start replay protection service
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    console.log('[ReplayProtectionService] Starting replay protection');

    this.isRunning = true;
    this.startCleanupLoop();
  }

  /**
   * Stop replay protection service
   */
  stop(): void {
    if (!this.isRunning) return;

    console.log('[ReplayProtectionService] Stopping replay protection');

    if (this.cleanupInterval) {
      // eslint-disable-next-line no-undef
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    this.isRunning = false;
  }

  /**
   * Start cleanup loop
   */
  private startCleanupLoop(): void {
    // eslint-disable-next-line no-undef
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldMessages();
    }, this.config.cleanupInterval);
  }

  /**
   * Check if message is valid (not a replay)
   */
  isValidMessage(metadata: MessageMetadata): boolean {
    const now = Date.now();
    const age = now - metadata.timestamp;

    // Check if message is too old
    if (age > this.config.maxAge) {
      console.log(`[ReplayProtectionService] Message too old: ${age}ms`);
      return false;
    }

    // Check if message ID was already used
    const existingMessage = this.messageHistory.get(metadata.messageId);
    if (existingMessage) {
      console.log(`[ReplayProtectionService] Duplicate message ID: ${metadata.messageId}`);
      return false;
    }

    // Check if nonce was already used by this peer
    const nonceKey = `${metadata.peerId}_${metadata.nonce}`;
    const existingNonce = this.nonceHistory.get(nonceKey);
    if (existingNonce) {
      console.log(`[ReplayProtectionService] Duplicate nonce: ${metadata.nonce}`);
      return false;
    }

    // Message is valid, record it
    this.messageHistory.set(metadata.messageId, metadata);
    this.nonceHistory.set(nonceKey, metadata.timestamp);

    return true;
  }

  /**
   * Generate unique message ID using expo-crypto
   */
  async generateMessageId(peerId: PeerId): Promise<string> {
    const randomBytes = await Crypto.getRandomBytesAsync(8);
    const randomPart = Array.from(randomBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `${peerId}_${Date.now()}_${randomPart}`;
  }

  /**
   * Generate unique nonce using expo-crypto
   */
  async generateNonce(): Promise<string> {
    const randomBytes = await Crypto.getRandomBytesAsync(8);
    return Array.from(randomBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Cleanup old messages
   */
  private cleanupOldMessages(): void {
    const now = Date.now();
    let removed = 0;

    // Clean message history
    for (const [messageId, metadata] of this.messageHistory.entries()) {
      if (now - metadata.timestamp > this.config.maxAge) {
        this.messageHistory.delete(messageId);
        removed++;
      }
    }

    // Clean nonce history
    for (const [nonceKey, timestamp] of this.nonceHistory.entries()) {
      if (now - timestamp > this.config.maxAge) {
        this.nonceHistory.delete(nonceKey);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`[ReplayProtectionService] Cleaned ${removed} old entries`);
    }
  }

  /**
   * Get message history size
   */
  getMessageHistorySize(): number {
    return this.messageHistory.size;
  }

  /**
   * Get nonce history size
   */
  getNonceHistorySize(): number {
    return this.nonceHistory.size;
  }

  /**
   * Clear all history
   */
  clearHistory(): void {
    this.messageHistory.clear();
    this.nonceHistory.clear();
  }
}
