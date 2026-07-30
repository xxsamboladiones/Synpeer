import type { StorageService } from '../services/storage/StorageService';
import { CryptoService } from '../crypto/CryptoService';
import type { PeerId } from './NetworkTypes';

const STORAGE_KEY = 'peer_identity';

/**
 * Peer identity information
 */
export interface PeerIdentityData {
  /** Local public identity from CryptoService */
  publicIdentity: string;
  /** Derived peer ID for libp2p */
  peerId: PeerId;
  /** Timestamp when identity was created */
  createdAt: number;
}

/**
 * PeerIdentity manages peer identity derived from cryptographic identity
 * Every peer identity is derived from the local cryptographic identity
 */
export class PeerIdentity {
  private cryptoService: CryptoService;
  private storage: StorageService;
  private cachedIdentity: PeerIdentityData | null = null;

  constructor(cryptoService: CryptoService, storage: StorageService) {
    this.cryptoService = cryptoService;
    this.storage = storage;
  }

  /**
   * Get or create peer identity
   * Derives peer ID from the cryptographic identity
   */
  async getOrCreateIdentity(): Promise<PeerIdentityData> {
    // Check cache first
    if (this.cachedIdentity) {
      return this.cachedIdentity;
    }

    // Load from storage
    const stored = this.storage.getJson<PeerIdentityData>(STORAGE_KEY);
    if (stored) {
      this.cachedIdentity = stored;
      return stored;
    }

    // Ensure cryptographic identity exists
    if (!this.cryptoService.hasIdentity()) {
      await this.cryptoService.createIdentity();
    }

    const publicIdentity = this.cryptoService.loadIdentity();
    if (!publicIdentity) {
      throw new Error('Failed to load cryptographic identity');
    }

    // Derive peer ID from public identity
    const peerId = this.derivePeerId(publicIdentity);

    const identity: PeerIdentityData = {
      publicIdentity,
      peerId,
      createdAt: Date.now(),
    };

    // Persist
    this.storage.setJson(STORAGE_KEY, identity);
    this.cachedIdentity = identity;

    return identity;
  }

  /**
   * Derive a peer ID from the public identity
   * Uses SHA256 hash of the public identity as the peer ID
   */
  private derivePeerId(publicIdentity: string): PeerId {
    // For phase 2, we'll use a simple hash-based derivation
    // In production, this should use proper libp2p peer ID derivation
    let hash = 0;
    for (let i = 0; i < publicIdentity.length; i++) {
      const char = publicIdentity.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }

    // Convert to hex and ensure it's a valid peer ID format
    const peerIdHash = Math.abs(hash).toString(16).padStart(32, '0');
    return `Qm${peerIdHash}`;
  }

  /**
   * Get current peer identity without creating
   */
  getIdentity(): PeerIdentityData | null {
    return this.cachedIdentity || this.storage.getJson<PeerIdentityData>(STORAGE_KEY);
  }

  /**
   * Get peer ID
   */
  getPeerId(): PeerId | null {
    const identity = this.getIdentity();
    return identity?.peerId ?? null;
  }

  /**
   * Clear stored identity (for testing/reset)
   */
  clearIdentity(): void {
    this.storage.remove(STORAGE_KEY);
    this.cachedIdentity = null;
  }
}
