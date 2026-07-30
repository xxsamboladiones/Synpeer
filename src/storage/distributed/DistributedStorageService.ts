import type { PeerId } from '../../network/NetworkTypes';
import { getNetworkService } from '../../services/network/NetworkService';
import { decodeUtf8, encodeUtf8 } from '../../utils/hash';
import { createLogger } from '../../observability/Logger';

export interface DistributedStorageConfig {
  replicationFactor: number;
  minReplicas: number;
  maxStorage: number; // in bytes
  gcInterval: number; // in milliseconds
}

export interface StorageItem {
  key: string;
  value: string;
  size: number;
  replicas: PeerId[];
  createdAt: number;
  lastAccessed: number;
  expiresAt: number;
}

interface StorageReplicaPacket {
  type: 'STORAGE_REPLICA';
  key: string;
  value: string;
  expiresAt: number;
  createdAt: number;
  sourcePeerId: PeerId;
}

const STORAGE_PROTOCOL = '/synpeer/storage/1.0.0';
const LEGACY_STORAGE_PROTOCOL = '/insta99/storage/1.0.0';

/**
 * DistributedStorageService manages distributed storage with replication
 * Each piece of content is replicated to multiple peers for redundancy
 */
export class DistributedStorageService {
  private readonly logger = createLogger('DistributedStorageService');
  private config: DistributedStorageConfig;
  private storage: Map<string, StorageItem>;
  private localPeerId: PeerId;
  private gcInterval: number | null = null;
  private unregisterStorageProtocols: Array<() => Promise<void>> = [];
  private isRunning: boolean = false;

  constructor(config: DistributedStorageConfig, localPeerId: PeerId) {
    this.config = {
      replicationFactor: config.replicationFactor ?? 5,
      minReplicas: config.minReplicas ?? 3,
      maxStorage: config.maxStorage ?? 1073741824,
      gcInterval: config.gcInterval ?? 3600000,
    };
    this.storage = new Map();
    this.localPeerId = localPeerId;
  }

  /**
   * Start distributed storage service
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    this.logger.info('start_requested');

    this.isRunning = true;
    await this.registerStorageProtocol();
    this.startGarbageCollection();
  }

  /**
   * Stop distributed storage service
   */
  stop(): void {
    if (!this.isRunning) return;

    this.logger.info('stop_requested');

    if (this.gcInterval) {
      globalThis.clearInterval(this.gcInterval);
      this.gcInterval = null;
    }

    for (const unregister of this.unregisterStorageProtocols) {
      void unregister();
    }
    this.unregisterStorageProtocols = [];

    this.isRunning = false;
  }

  /**
   * Start garbage collection loop
   */
  private startGarbageCollection(): void {
    this.gcInterval = globalThis.setInterval(() => {
      this.runGarbageCollection();
    }, this.config.gcInterval) as unknown as number;
  }

  /**
   * Store data with replication
   */
  async store(key: string, value: string, ttl: number = 2592000000): Promise<void> {
    const size = encodeUtf8(value).length;
    const now = Date.now();

    const item: StorageItem = {
      key,
      value,
      size,
      replicas: [this.localPeerId],
      createdAt: now,
      lastAccessed: now,
      expiresAt: now + ttl,
    };

    this.storage.set(key, item);

    // Replicate to other peers
    await this.replicateToPeers(key);
  }

  /**
   * Retrieve data from storage
   */
  async retrieve(key: string): Promise<string | null> {
    const item = this.storage.get(key);

    if (!item) {
      return null;
    }

    if (item.expiresAt < Date.now()) {
      this.storage.delete(key);
      return null;
    }

    item.lastAccessed = Date.now();
    return item.value;
  }

  /**
   * Replicate data to peers
   */
  private async replicateToPeers(key: string): Promise<void> {
    const item = this.storage.get(key);
    if (!item) {
      return;
    }

    try {
      const networkService = getNetworkService();
      if (!networkService.isRunning()) {
        return;
      }

      const peerManager = networkService.getPeerManager();
      const peers = networkService
        .getConnectedPeers()
        .filter((peerId) => peerId !== this.localPeerId && !item.replicas.includes(peerId))
        .slice(0, Math.max(0, this.config.replicationFactor - item.replicas.length));

      const packet = encodeUtf8(
        JSON.stringify({
          type: 'STORAGE_REPLICA',
          key: item.key,
          value: item.value,
          expiresAt: item.expiresAt,
          createdAt: item.createdAt,
          sourcePeerId: this.localPeerId,
        }),
      );

      for (const peerId of peers) {
        let streamId: string | null = null;
        try {
          streamId = await this.openStorageStream(peerManager, peerId);
          await peerManager.sendStreamData(streamId, packet);
          this.addReplica(key, peerId);
        } finally {
          if (streamId) {
            await peerManager.closeStream(streamId);
          }
        }
      }
    } catch (error) {
      this.logger.error('replication_failed', error, { key });
    }
  }

  private async registerStorageProtocol(): Promise<void> {
    try {
      const networkService = getNetworkService();
      if (!networkService.isRunning()) {
        return;
      }

      const peerManager = networkService.getPeerManager();
      const handler = async ({ data, peerId }: { data: Uint8Array; peerId: PeerId }) => {
        await this.receiveReplica(decodeUtf8(data), peerId);
      };
      this.unregisterStorageProtocols = await Promise.all([
        peerManager.handleProtocol(STORAGE_PROTOCOL, handler),
        peerManager.handleProtocol(LEGACY_STORAGE_PROTOCOL, handler),
      ]);
    } catch (error) {
      this.logger.error('protocol_registration_failed', error);
    }
  }

  private async openStorageStream(
    peerManager: ReturnType<ReturnType<typeof getNetworkService>['getPeerManager']>,
    peerId: PeerId,
  ): Promise<string> {
    try {
      return await peerManager.openStream(peerId, STORAGE_PROTOCOL);
    } catch {
      return await peerManager.openStream(peerId, LEGACY_STORAGE_PROTOCOL);
    }
  }

  async receiveReplica(packetData: string, peerId: PeerId): Promise<boolean> {
    try {
      const packet = JSON.parse(packetData) as StorageReplicaPacket;
      if (
        packet.type !== 'STORAGE_REPLICA' ||
        !packet.key ||
        typeof packet.value !== 'string' ||
        packet.expiresAt <= Date.now()
      ) {
        return false;
      }

      const existing = this.storage.get(packet.key);
      if (existing && existing.createdAt > packet.createdAt) {
        this.addReplica(packet.key, peerId);
        return true;
      }

      const now = Date.now();
      this.storage.set(packet.key, {
        key: packet.key,
        value: packet.value,
        size: encodeUtf8(packet.value).length,
        replicas: Array.from(new Set([this.localPeerId, packet.sourcePeerId, peerId])),
        createdAt: packet.createdAt,
        lastAccessed: now,
        expiresAt: packet.expiresAt,
      });

      return true;
    } catch (error) {
      this.logger.error('replica_receive_failed', error, { peerId });
      return false;
    }
  }

  /**
   * Add replica peer for a key
   */
  addReplica(key: string, peerId: PeerId): void {
    const item = this.storage.get(key);
    if (item && !item.replicas.includes(peerId)) {
      item.replicas.push(peerId);
    }
  }

  /**
   * Remove replica peer for a key
   */
  removeReplica(key: string, peerId: PeerId): void {
    const item = this.storage.get(key);
    if (item) {
      item.replicas = item.replicas.filter((id) => id !== peerId);
    }
  }

  /**
   * Check if item has enough replicas
   */
  hasEnoughReplicas(key: string): boolean {
    const item = this.storage.get(key);
    if (!item) return false;
    return item.replicas.length >= this.config.minReplicas;
  }

  /**
   * Get storage usage
   */
  getStorageUsage(): { used: number; total: number; percentage: number } {
    let used = 0;
    for (const item of this.storage.values()) {
      used += item.size;
    }
    return {
      used,
      total: this.config.maxStorage,
      percentage: (used / this.config.maxStorage) * 100,
    };
  }

  /**
   * Run garbage collection
   */
  private runGarbageCollection(): void {
    const now = Date.now();
    let removed = 0;

    // Remove expired items
    for (const [key, item] of this.storage.entries()) {
      if (item.expiresAt < now) {
        this.storage.delete(key);
        removed++;
      }
    }

    // Remove old items if storage is full
    const usage = this.getStorageUsage();
    if (usage.percentage > 90) {
      const sortedItems = Array.from(this.storage.entries()).sort(
        ([, a], [, b]) => a.lastAccessed - b.lastAccessed,
      );

      const toRemove = sortedItems.slice(0, Math.floor(sortedItems.length * 0.1));
      for (const [key] of toRemove) {
        this.storage.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.info('garbage_collection_completed', { removed });
    }
  }

  /**
   * Get all keys
   */
  getAllKeys(): string[] {
    return Array.from(this.storage.keys());
  }

  /**
   * Get item info
   */
  getItemInfo(key: string): StorageItem | undefined {
    return this.storage.get(key);
  }

  /**
   * Delete item
   */
  delete(key: string): boolean {
    return this.storage.delete(key);
  }

  /**
   * Clear all storage
   */
  clear(): void {
    this.storage.clear();
  }

  /**
   * Get storage size
   */
  getSize(): number {
    return this.storage.size;
  }
}
