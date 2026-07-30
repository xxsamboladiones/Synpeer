import { CryptoService } from '../CryptoService';
import { createStorageService } from '../../services/storage/StorageService';
import { sha256Hex } from '../../utils/hash';

// Mock expo-crypto to avoid native module issues in Jest
let mockKeyCounter = 0;

jest.mock('expo-crypto', () => ({
  getRandomBytesAsync: jest.fn(() => {
    // Return a mock 32-byte private key with incrementing values
    mockKeyCounter++;
    return Promise.resolve(new Uint8Array(32).map((_, i) => (i + mockKeyCounter) % 256));
  }),
  digestStringAsync: jest.fn((algorithm: string, data: string) => {
    // Return a mock 32-byte public key as hex string based on input
    // Different inputs produce different outputs
    const hash = data.split('').reduce((acc: number, char: string) => acc + char.charCodeAt(0), 0);
    const hex = Array.from({ length: 32 }, (_, i) =>
      ((hash + i) % 256).toString(16).padStart(2, '0'),
    ).join('');
    return Promise.resolve(hex);
  }),
  CryptoDigestAlgorithm: {
    SHA256: 'SHA256',
  },
  CryptoEncoding: {
    HEX: 'hex',
  },
}));

// Mock storage driver for testing
const mockStorage = new Map<string, string>();

const mockStorageDriver = {
  getString: jest.fn((key: string) => mockStorage.get(key) ?? null),
  setString: jest.fn((key: string, value: string) => {
    mockStorage.set(key, value);
  }),
  remove: jest.fn((key: string) => {
    mockStorage.delete(key);
  }),
  clear: jest.fn(() => {
    mockStorage.clear();
  }),
};

describe('CryptoService', () => {
  let cryptoService: CryptoService;
  let storageService: ReturnType<typeof createStorageService>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockStorage.clear();
    mockKeyCounter = 0;
    storageService = createStorageService(mockStorageDriver);
    cryptoService = new CryptoService(storageService);
  });

  describe('createIdentity', () => {
    it('should generate a new identity with a valid public key', async () => {
      const publicIdentity = await cryptoService.createIdentity();

      expect(publicIdentity).toBeDefined();
      expect(typeof publicIdentity).toBe('string');
      expect(publicIdentity.length).toBe(64); // Ed25519 public key is 32 bytes = 64 hex chars
    });

    it('should store the identity in storage', async () => {
      await cryptoService.createIdentity();

      expect(mockStorageDriver.setString).toHaveBeenCalled();
      const storedData = JSON.parse((mockStorageDriver.setString as jest.Mock).mock.calls[0][1]);
      expect(storedData.publicIdentity).toBeDefined();
      expect(storedData.encryptedPrivateKey).toBeDefined();
      expect(storedData.createdAt).toBeDefined();
    });

    it('should generate unique identities', async () => {
      const identity1 = await cryptoService.createIdentity();
      const identity2 = await cryptoService.createIdentity();

      expect(identity1).not.toBe(identity2);
    });
  });

  describe('loadIdentity', () => {
    it('should return null when no identity exists', () => {
      const identity = cryptoService.loadIdentity();
      expect(identity).toBeNull();
    });

    it('should return the public identity when one exists', async () => {
      const createdIdentity = await cryptoService.createIdentity();
      const loadedIdentity = cryptoService.loadIdentity();

      expect(loadedIdentity).toBe(createdIdentity);
    });
  });

  describe('hasIdentity', () => {
    it('should return false when no identity exists', () => {
      expect(cryptoService.hasIdentity()).toBe(false);
    });

    it('should return true when identity exists', async () => {
      await cryptoService.createIdentity();
      expect(cryptoService.hasIdentity()).toBe(true);
    });
  });

  describe('clearIdentity', () => {
    it('should remove the stored identity', async () => {
      await cryptoService.createIdentity();
      expect(cryptoService.hasIdentity()).toBe(true);

      cryptoService.clearIdentity();
      expect(mockStorageDriver.remove).toHaveBeenCalledWith('identity');
      expect(cryptoService.hasIdentity()).toBe(false);
    });
  });

  describe('sign and verify', () => {
    it('should sign and verify data with the stored identity', async () => {
      const publicIdentity = await cryptoService.createIdentity();
      const signature = await cryptoService.sign('hello');

      await expect(cryptoService.verify('hello', signature, publicIdentity)).resolves.toBe(true);
      await expect(cryptoService.verify('tampered', signature, publicIdentity)).resolves.toBe(
        false,
      );
    });

    it('encrypts private messages so only the intended peer can decrypt them', async () => {
      const alice = new CryptoService(createIsolatedStorageService());
      const bob = new CryptoService(createIsolatedStorageService());
      const mallory = new CryptoService(createIsolatedStorageService());
      const [aliceId, bobId] = await Promise.all([
        alice.createIdentity(),
        bob.createIdentity(),
        mallory.createIdentity(),
      ]).then(([createdAliceId, createdBobId]) => [createdAliceId, createdBobId]);
      const context = `chat:${aliceId}:${bobId}:message-1`;

      const encrypted = await alice.encryptForPeer(bobId, 'private hello', context);

      expect(encrypted.ciphertext).not.toContain('private hello');
      await expect(bob.decryptFromPeer(aliceId, encrypted, context)).resolves.toBe('private hello');
      await expect(mallory.decryptFromPeer(aliceId, encrypted, context)).rejects.toMatchObject({
        code: 'IDENTITY_ERROR',
      });
    });
  });

  describe('identity backup', () => {
    it('should export a versioned backup with the private identity material', async () => {
      const publicIdentity = await cryptoService.createIdentity();
      const backup = JSON.parse(cryptoService.exportIdentityBackup(123));

      expect(backup).toMatchObject({
        type: 'synpeer.identity.backup',
        version: 1,
        exportedAt: 123,
        identity: {
          publicIdentity,
        },
      });
      expect(backup.identity.encryptedPrivateKey).toHaveLength(64);
      expect(backup.checksum).toHaveLength(64);
    });

    it('should restore an exported backup into another storage instance', async () => {
      const publicIdentity = await cryptoService.createIdentity();
      const backup = cryptoService.exportIdentityBackup(123);
      const restoredStorage = new Map<string, string>();
      const restoredService = new CryptoService(
        createStorageService({
          getString: (key) => restoredStorage.get(key) ?? null,
          setString: (key, value) => {
            restoredStorage.set(key, value);
          },
          remove: (key) => {
            restoredStorage.delete(key);
          },
          clear: () => {
            restoredStorage.clear();
          },
        }),
      );

      await expect(restoredService.importIdentityBackup(backup)).resolves.toBe(publicIdentity);
      expect(restoredService.loadIdentity()).toBe(publicIdentity);

      const signature = await restoredService.sign('restored-message');
      await expect(
        restoredService.verify('restored-message', signature, publicIdentity),
      ).resolves.toBe(true);
    });

    it('should continue to restore legacy identity backups', async () => {
      const publicIdentity = await cryptoService.createIdentity();
      const current = JSON.parse(cryptoService.exportIdentityBackup(123));
      const unsignedLegacy = {
        type: 'insta99.identity.backup',
        version: current.version,
        exportedAt: current.exportedAt,
        identity: current.identity,
      };
      const legacy = {
        ...unsignedLegacy,
        checksum: sha256Hex(canonicalJsonForTest(unsignedLegacy)),
      };

      await expect(cryptoService.importIdentityBackup(JSON.stringify(legacy))).resolves.toBe(
        publicIdentity,
      );
    });

    it('should reject backups with a changed checksum', async () => {
      await cryptoService.createIdentity();
      const backup = JSON.parse(cryptoService.exportIdentityBackup(123));
      backup.identity.publicIdentity = 'a'.repeat(64);

      await expect(
        cryptoService.importIdentityBackup(JSON.stringify(backup)),
      ).rejects.toMatchObject({
        code: 'IDENTITY_ERROR',
      });
    });
  });
});

function createIsolatedStorageService(): ReturnType<typeof createStorageService> {
  const values = new Map<string, string>();
  return createStorageService({
    getString: (key) => values.get(key) ?? null,
    setString: (key, value) => {
      values.set(key, value);
    },
    remove: (key) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
  });
}

function canonicalJsonForTest(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonForTest).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonForTest(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
