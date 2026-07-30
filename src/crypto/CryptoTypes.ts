/**
 * Cryptographic identity types for Synpeer
 * Private key material is never exposed outside src/crypto
 */

/**
 * Portable public identity format
 * Deterministic encoding of the Ed25519 public key
 */
export type PublicIdentity = string;

/**
 * Internal type for key pair - never exported outside crypto module
 */
export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface PrivateMessageCiphertext {
  version: 1;
  algorithm: 'x25519-aes-256-gcm';
  ciphertext: string;
  nonce: string;
}

/**
 * Stored encrypted identity format (for local persistence)
 */
export interface StoredIdentity {
  publicIdentity: PublicIdentity;
  encryptedPrivateKey: string;
  createdAt: number;
}

export interface IdentityBackupV1 {
  type: 'synpeer.identity.backup' | 'insta99.identity.backup';
  version: 1;
  exportedAt: number;
  identity: StoredIdentity;
  checksum: string;
}
