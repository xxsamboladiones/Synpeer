import * as Crypto from 'expo-crypto';
import * as ed25519 from '@noble/ed25519';
import { gcm } from '@noble/ciphers/aes.js';
import { ed25519 as ed25519Curve, x25519 } from '@noble/curves/ed25519.js';

import { type StorageService } from '../services/storage/StorageService';
import { AppError } from '../errors/AppError';
import type {
  IdentityBackupV1,
  KeyPair,
  PrivateMessageCiphertext,
  PublicIdentity,
  StoredIdentity,
} from './CryptoTypes';
import { decodeUtf8, encodeUtf8, sha256Hex } from '../utils/hash';

const STORAGE_KEY = 'identity';
const BACKUP_TYPE: IdentityBackupV1['type'] = 'synpeer.identity.backup';
const LEGACY_BACKUP_TYPE: IdentityBackupV1['type'] = 'insta99.identity.backup';
const BACKUP_VERSION: IdentityBackupV1['version'] = 1;
const PRIVATE_MESSAGE_KEY_DOMAIN = 'synpeer:private-message:v1';
const LEGACY_PRIVATE_MESSAGE_KEY_DOMAIN = 'insta99:private-message:v1';

/**
 * Convert Uint8Array to hex string
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * CryptoService handles cryptographic identity generation and persistence
 * Private key material is never exposed outside this module
 */
export class CryptoService {
  private storage: StorageService;

  constructor(storage: StorageService) {
    this.storage = storage;
  }

  /**
   * Generate a new cryptographic key pair
   * Using expo-crypto for secure random bytes
   * @returns KeyPair with public and private keys (internal use only)
   */
  private async generateKeyPair(): Promise<KeyPair> {
    const privateKey = await Crypto.getRandomBytesAsync(32);
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);

    return {
      publicKey,
      privateKey,
    };
  }

  /**
   * Convert public key bytes to portable hex string format
   * @param publicKey - Public key bytes
   * @returns Portable public identity string
   */
  private publicKeyToIdentity(publicKey: Uint8Array): PublicIdentity {
    return bytesToHex(publicKey);
  }

  /**
   * Create a new cryptographic identity
   * @returns The public identity string
   */
  async createIdentity(): Promise<PublicIdentity> {
    const keyPair = await this.generateKeyPair();
    const publicIdentity = this.publicKeyToIdentity(keyPair.publicKey);

    // Store encrypted identity locally
    const storedIdentity: StoredIdentity = {
      publicIdentity,
      encryptedPrivateKey: bytesToHex(keyPair.privateKey),
      createdAt: Date.now(),
    };

    this.storage.setJson(STORAGE_KEY, storedIdentity);

    return publicIdentity;
  }

  /**
   * Load existing identity from storage
   * @returns The public identity string, or null if not found
   */
  loadIdentity(): PublicIdentity | null {
    const stored = this.storage.getJson<StoredIdentity>(STORAGE_KEY);
    return stored?.publicIdentity ?? null;
  }

  /**
   * Check if an identity exists
   * @returns true if identity exists in storage
   */
  hasIdentity(): boolean {
    return this.loadIdentity() !== null;
  }

  /**
   * Clear the stored identity (for testing/reset purposes)
   */
  clearIdentity(): void {
    this.storage.remove(STORAGE_KEY);
  }

  exportIdentityBackup(exportedAt = Date.now()): string {
    const stored = this.getStoredIdentity();
    if (!stored) {
      throw new AppError({
        code: 'IDENTITY_ERROR',
        message: 'Cannot export identity backup without a local identity',
        safeMessage: 'Crie ou importe uma identidade antes de exportar o backup.',
        severity: 'warning',
        retryable: false,
      });
    }

    const unsignedBackup = {
      type: BACKUP_TYPE,
      version: BACKUP_VERSION,
      exportedAt,
      identity: stored,
    };
    const backup: IdentityBackupV1 = {
      ...unsignedBackup,
      checksum: sha256Hex(canonicalJson(unsignedBackup)),
    };

    return JSON.stringify(backup, null, 2);
  }

  async importIdentityBackup(serializedBackup: string): Promise<PublicIdentity> {
    const backup = parseIdentityBackup(serializedBackup);
    const expectedChecksum = sha256Hex(
      canonicalJson({
        type: backup.type,
        version: backup.version,
        exportedAt: backup.exportedAt,
        identity: backup.identity,
      }),
    );
    if (backup.checksum !== expectedChecksum) {
      throw new AppError({
        code: 'IDENTITY_ERROR',
        message: 'Identity backup checksum mismatch',
        safeMessage: 'O backup da identidade esta corrompido ou foi alterado.',
        severity: 'error',
        retryable: false,
      });
    }

    await this.validateStoredIdentity(backup.identity);
    this.storage.setJson(STORAGE_KEY, backup.identity);
    return backup.identity.publicIdentity;
  }

  async sign(data: string): Promise<string> {
    const stored = this.getStoredIdentity();
    if (!stored) {
      throw new Error('Cannot sign without a local identity');
    }

    const signature = await ed25519.signAsync(
      encodeUtf8(data),
      hexToBytes(stored.encryptedPrivateKey),
    );
    return bytesToHex(signature);
  }

  async verify(data: string, signature: string, publicIdentity: PublicIdentity): Promise<boolean> {
    try {
      return await ed25519.verifyAsync(
        hexToBytes(signature),
        encodeUtf8(data),
        hexToBytes(publicIdentity),
      );
    } catch {
      return false;
    }
  }

  async encryptForPeer(
    peerPublicIdentity: PublicIdentity,
    plaintext: string,
    context: string,
  ): Promise<PrivateMessageCiphertext> {
    const key = this.derivePrivateMessageKey(peerPublicIdentity, context);
    const randomBytes = await Crypto.getRandomBytesAsync(12);
    const nonce = randomBytes.slice(0, 12);
    const ciphertext = gcm(key, nonce, encodeUtf8(context)).encrypt(encodeUtf8(plaintext));

    return {
      version: 1,
      algorithm: 'x25519-aes-256-gcm',
      ciphertext: bytesToHex(ciphertext),
      nonce: bytesToHex(nonce),
    };
  }

  async decryptFromPeer(
    peerPublicIdentity: PublicIdentity,
    encrypted: PrivateMessageCiphertext,
    context: string,
  ): Promise<string> {
    if (
      encrypted.version !== 1 ||
      encrypted.algorithm !== 'x25519-aes-256-gcm' ||
      !isHex(encrypted.nonce, 24) ||
      !isHexValue(encrypted.ciphertext)
    ) {
      throw new AppError({
        code: 'VALIDATION_ERROR',
        message: 'Private message ciphertext is invalid',
        safeMessage: 'A mensagem privada recebida e invalida.',
        severity: 'warning',
        retryable: false,
      });
    }

    try {
      return this.decryptPrivateMessage(peerPublicIdentity, encrypted, context);
    } catch (currentError) {
      const legacyContext = toLegacyPrivateMessageContext(context);
      try {
        return this.decryptPrivateMessage(
          peerPublicIdentity,
          encrypted,
          legacyContext,
          LEGACY_PRIVATE_MESSAGE_KEY_DOMAIN,
        );
      } catch {
        throw new AppError({
          code: 'IDENTITY_ERROR',
          message: 'Private message decryption failed',
          safeMessage: 'Nao foi possivel abrir a mensagem privada.',
          severity: 'warning',
          retryable: false,
          cause: currentError,
        });
      }
    }
  }

  getPublicIdentity(): PublicIdentity | null {
    return this.loadIdentity();
  }

  private derivePrivateMessageKey(
    peerPublicIdentity: PublicIdentity,
    context: string,
    domain = PRIVATE_MESSAGE_KEY_DOMAIN,
  ): Uint8Array {
    const stored = this.getStoredIdentity();
    if (!stored) {
      throw new AppError({
        code: 'IDENTITY_ERROR',
        message: 'Cannot derive a private message key without a local identity',
        safeMessage: 'Crie ou importe uma identidade antes de enviar mensagens.',
        severity: 'warning',
        retryable: false,
      });
    }
    if (!isHex(peerPublicIdentity, 64)) {
      throw new AppError({
        code: 'VALIDATION_ERROR',
        message: 'Remote public identity is invalid',
        safeMessage: 'A identidade publica do destinatario e invalida.',
        severity: 'warning',
        retryable: false,
      });
    }

    const localSecret = ed25519Curve.utils.toMontgomerySecret(
      hexToBytes(stored.encryptedPrivateKey),
    );
    const remotePublicKey = ed25519Curve.utils.toMontgomery(hexToBytes(peerPublicIdentity));
    const sharedSecret = x25519.getSharedSecret(localSecret, remotePublicKey);
    const participants = [stored.publicIdentity, peerPublicIdentity].sort().join(':');
    const keyMaterial = concatBytes(
      sharedSecret,
      encodeUtf8(`${domain}:${participants}:${context}`),
    );
    return hexToBytes(sha256Hex(keyMaterial));
  }

  private decryptPrivateMessage(
    peerPublicIdentity: PublicIdentity,
    encrypted: PrivateMessageCiphertext,
    context: string,
    domain = PRIVATE_MESSAGE_KEY_DOMAIN,
  ): string {
    const key = this.derivePrivateMessageKey(peerPublicIdentity, context, domain);
    const plaintext = gcm(key, hexToBytes(encrypted.nonce), encodeUtf8(context)).decrypt(
      hexToBytes(encrypted.ciphertext),
    );
    return decodeUtf8(plaintext);
  }

  private getStoredIdentity(): StoredIdentity | null {
    const stored = this.storage.getJson<StoredIdentity>(STORAGE_KEY);
    return isStoredIdentity(stored) ? stored : null;
  }

  private async validateStoredIdentity(identity: StoredIdentity): Promise<void> {
    const privateKey = hexToBytes(identity.encryptedPrivateKey);
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const derivedIdentity = this.publicKeyToIdentity(publicKey);
    if (derivedIdentity !== identity.publicIdentity) {
      throw new AppError({
        code: 'IDENTITY_ERROR',
        message: 'Identity backup key pair does not match',
        safeMessage: 'A chave privada do backup nao corresponde a identidade publica.',
        severity: 'error',
        retryable: false,
      });
    }
  }
}

function parseIdentityBackup(serializedBackup: string): IdentityBackupV1 {
  try {
    const parsed = JSON.parse(serializedBackup);
    if (isIdentityBackupV1(parsed)) {
      return parsed;
    }
  } catch (error) {
    throw new AppError({
      code: 'IDENTITY_ERROR',
      message: 'Identity backup is not valid JSON',
      safeMessage: 'O backup informado nao e um JSON valido.',
      severity: 'warning',
      retryable: false,
      cause: error,
    });
  }

  throw new AppError({
    code: 'IDENTITY_ERROR',
    message: 'Unsupported identity backup format',
    safeMessage: 'Formato de backup de identidade invalido ou incompativel.',
    severity: 'warning',
    retryable: false,
  });
}

function isIdentityBackupV1(value: unknown): value is IdentityBackupV1 {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.type === BACKUP_TYPE || value.type === LEGACY_BACKUP_TYPE) &&
    value.version === BACKUP_VERSION &&
    typeof value.exportedAt === 'number' &&
    isStoredIdentity(value.identity) &&
    isHex(value.checksum, 64)
  );
}

function isStoredIdentity(value: unknown): value is StoredIdentity {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isHex(value.publicIdentity, 64) &&
    isHex(value.encryptedPrivateKey, 64) &&
    typeof value.createdAt === 'number'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHex(value: unknown, length: number): value is string {
  return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/i.test(value);
}

function isHexValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 32 &&
    value.length % 2 === 0 &&
    /^[0-9a-f]+$/i.test(value)
  );
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left);
  combined.set(right, left.length);
  return combined;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function toLegacyPrivateMessageContext(context: string): string {
  const currentPrefix = 'synpeer:chat:v1:';
  return context.startsWith(currentPrefix)
    ? `insta99:chat:v1:${context.slice(currentPrefix.length)}`
    : context;
}
