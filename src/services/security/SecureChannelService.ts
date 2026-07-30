import type { PeerId } from '../../network/NetworkTypes';
import { CryptoService } from '../../crypto/CryptoService';
import { localStorageService } from '../../services/storage/mmkvStorage';
import * as Crypto from 'expo-crypto';
import { encodeUtf8, sha256Hex } from '../../utils/hash';

export interface SecureChannelConfig {
  protocol: 'noise' | 'tls';
  keyExchange: 'x25519' | 'secp256k1';
  cipher: 'aes256' | 'chacha20';
  handshakeTimeout: number;
}

export interface EncryptedMessage {
  peerId: PeerId;
  encryptedData: string;
  nonce: string;
  timestamp: number;
}

export interface SessionInfo {
  peerId: PeerId;
  sessionKey: string;
  establishedAt: number;
  lastUsed: number;
}

/**
 * SecureChannelService manages encrypted communication channels
 * Implements Noise Protocol or TLS for secure P2P communication
 */
export class SecureChannelService {
  private config: SecureChannelConfig;
  private sessions: Map<PeerId, SessionInfo>;
  private localKeyPair: { publicKey: string; privateKey: string } | null = null;
  private cryptoService: CryptoService;

  constructor(config: SecureChannelConfig) {
    this.config = {
      protocol: config.protocol ?? 'noise',
      keyExchange: config.keyExchange ?? 'x25519',
      cipher: config.cipher ?? 'aes256',
      handshakeTimeout: config.handshakeTimeout ?? 30000,
    };
    this.sessions = new Map();
    this.cryptoService = new CryptoService(localStorageService);
  }

  /**
   * Initialize secure channel service
   */
  async initialize(): Promise<void> {
    console.log('[SecureChannelService] Initializing secure channel');

    // Generate local key pair using CryptoService
    this.localKeyPair = await this.generateKeyPair();

    console.log('[SecureChannelService] Secure channel initialized');
  }

  /**
   * Generate key pair using CryptoService
   */
  private async generateKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
    try {
      const identity = this.cryptoService.loadIdentity();
      if (!identity) {
        throw new Error('No identity found. Create identity first.');
      }

      // Use the existing identity keys
      return {
        publicKey: identity,
        privateKey: identity, // In production, these would be separate
      };
    } catch (error) {
      console.error('[SecureChannelService] Failed to generate key pair:', error);
      throw error;
    }
  }

  /**
   * Establish secure session with peer
   */
  async establishSession(peerId: PeerId, remotePublicKey: string): Promise<boolean> {
    console.log(`[SecureChannelService] Establishing session with ${peerId}`);

    try {
      // Generate session key using CryptoService
      const sessionKey = await this.generateSessionKey(remotePublicKey);

      const sessionInfo: SessionInfo = {
        peerId,
        sessionKey,
        establishedAt: Date.now(),
        lastUsed: Date.now(),
      };

      this.sessions.set(peerId, sessionInfo);

      console.log(`[SecureChannelService] Session established with ${peerId}`);
      return true;
    } catch (error) {
      console.error('[SecureChannelService] Failed to establish session:', error);
      return false;
    }
  }

  /**
   * Generate session key using CryptoService with improved derivation
   * Note: The actual Noise Protocol handshake is handled by libp2p via @chainsafe/libp2p-noise
   * This service manages the session keys for application-level encryption
   */
  private async generateSessionKey(remotePublicKey: string): Promise<string> {
    try {
      if (!this.localKeyPair) {
        throw new Error('Secure channel not initialized');
      }

      const participants = [this.localKeyPair.publicKey, remotePublicKey].sort().join(':');
      return sha256Hex(`${this.config.protocol}:${this.config.keyExchange}:${participants}`);
    } catch (error) {
      console.error('[SecureChannelService] Failed to generate session key:', error);
      throw error;
    }
  }

  /**
   * Encrypt message for peer
   */
  async encrypt(peerId: PeerId, data: string): Promise<EncryptedMessage> {
    const session = this.sessions.get(peerId);

    if (!session) {
      throw new Error(`No session established with peer ${peerId}`);
    }

    try {
      const nonce = await this.generateNonce();
      const encryptedBytes = await this.encryptBytes(session.sessionKey, nonce, encodeUtf8(data));

      const encryptedMessage: EncryptedMessage = {
        peerId,
        encryptedData: this.bytesToHex(encryptedBytes),
        nonce,
        timestamp: Date.now(),
      };

      session.lastUsed = Date.now();
      this.sessions.set(peerId, session);

      return encryptedMessage;
    } catch (error) {
      console.error('[SecureChannelService] Failed to encrypt message:', error);
      throw error;
    }
  }

  /**
   * Decrypt message from peer
   */
  async decrypt(message: EncryptedMessage): Promise<string> {
    const session = this.sessions.get(message.peerId);

    if (!session) {
      throw new Error(`No session established with peer ${message.peerId}`);
    }

    try {
      const decryptedBytes = await this.decryptBytes(
        session.sessionKey,
        message.nonce,
        this.hexToBytes(message.encryptedData),
      );

      session.lastUsed = Date.now();
      this.sessions.set(message.peerId, session);

      return this.decodeUtf8(decryptedBytes);
    } catch (error) {
      console.error('[SecureChannelService] Failed to decrypt message:', error);
      throw error;
    }
  }

  /**
   * Generate nonce using expo-crypto
   */
  private async generateNonce(): Promise<string> {
    try {
      const randomBytes = await Crypto.getRandomBytesAsync(16);
      return Array.from(randomBytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } catch (error) {
      console.error('[SecureChannelService] Failed to generate nonce:', error);
      throw error;
    }
  }

  private async encryptBytes(
    sessionKey: string,
    nonce: string,
    data: Uint8Array,
  ): Promise<Uint8Array> {
    const { gcm } = await import('@noble/ciphers/aes.js');
    return gcm(this.hexToBytes(sessionKey), this.hexToBytes(nonce)).encrypt(data);
  }

  private async decryptBytes(
    sessionKey: string,
    nonce: string,
    data: Uint8Array,
  ): Promise<Uint8Array> {
    const { gcm } = await import('@noble/ciphers/aes.js');
    return gcm(this.hexToBytes(sessionKey), this.hexToBytes(nonce)).decrypt(data);
  }

  private bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  private hexToBytes(hex: string): Uint8Array {
    if (hex.length % 2 !== 0) {
      throw new Error('Invalid hex string');
    }

    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  private decodeUtf8(bytes: Uint8Array): string {
    let output = '';
    for (let index = 0; index < bytes.length;) {
      const first = bytes[index++];
      if (first < 0x80) {
        output += String.fromCharCode(first);
      } else if (first < 0xe0) {
        const second = bytes[index++] & 0x3f;
        output += String.fromCharCode(((first & 0x1f) << 6) | second);
      } else if (first < 0xf0) {
        const second = bytes[index++] & 0x3f;
        const third = bytes[index++] & 0x3f;
        output += String.fromCharCode(((first & 0x0f) << 12) | (second << 6) | third);
      } else {
        const second = bytes[index++] & 0x3f;
        const third = bytes[index++] & 0x3f;
        const fourth = bytes[index++] & 0x3f;
        const codePoint = ((first & 0x07) << 18) | (second << 12) | (third << 6) | fourth;
        const adjusted = codePoint - 0x10000;
        output += String.fromCharCode(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff));
      }
    }

    return output;
  }

  /**
   * Check if session exists
   */
  hasSession(peerId: PeerId): boolean {
    return this.sessions.has(peerId);
  }

  /**
   * Get session info
   */
  getSessionInfo(peerId: PeerId): SessionInfo | undefined {
    return this.sessions.get(peerId);
  }

  /**
   * Close session with peer
   */
  closeSession(peerId: PeerId): void {
    this.sessions.delete(peerId);
    console.log(`[SecureChannelService] Session closed with ${peerId}`);
  }

  /**
   * Close all sessions
   */
  closeAllSessions(): void {
    const count = this.sessions.size;
    this.sessions.clear();
    console.log(`[SecureChannelService] Closed ${count} sessions`);
  }

  /**
   * Get public key
   */
  getPublicKey(): string | null {
    return this.localKeyPair ? this.localKeyPair.publicKey : null;
  }

  /**
   * Clean inactive sessions (not used in 1 hour)
   */
  cleanInactiveSessions(threshold: number = 3600000): number {
    const now = Date.now();
    let removed = 0;

    for (const [peerId, session] of this.sessions.entries()) {
      if (now - session.lastUsed > threshold) {
        this.sessions.delete(peerId);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`[SecureChannelService] Cleaned ${removed} inactive sessions`);
    }

    return removed;
  }

  /**
   * Get session count
   */
  getSessionCount(): number {
    return this.sessions.size;
  }
}
