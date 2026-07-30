import type { PeerId } from '../NetworkTypes';
import { getNetworkService } from '../../services/network/NetworkService';
import { encodeUtf8 } from '../../utils/hash';

export interface DHTConfig {
  k: number; // Replication factor
  alpha: number; // Parallelism
  idLength: number; // ID length in bits
}

export interface DHTEntry {
  key: string;
  value: string;
  peerId: PeerId;
  timestamp: number;
  expiresAt: number;
}

export interface DHTNode {
  peerId: PeerId;
  lastSeen: number;
  distance: number;
}

/**
 * DHTService implements Kademlia DHT for peer and content location
 * Each peer maintains a portion of the distributed hash table
 */
export class DHTService {
  private config: DHTConfig;
  private routingTable: Map<string, DHTNode[]>;
  private dataStore: Map<string, DHTEntry[]>;
  private localPeerId: PeerId;

  constructor(config: DHTConfig, localPeerId: PeerId) {
    this.config = {
      k: config.k || 20,
      alpha: config.alpha || 3,
      idLength: config.idLength || 160,
    };
    this.routingTable = new Map();
    this.dataStore = new Map();
    this.localPeerId = localPeerId;
  }

  /**
   * Calculate XOR distance between two keys
   */
  private calculateDistance(key1: string, key2: string): number {
    const k1 = this.keyToBigInt(key1);
    const k2 = this.keyToBigInt(key2);
    return Number(k1 ^ k2);
  }

  /**
   * Convert key to BigInt
   */
  private keyToBigInt(key: string): bigint {
    return BigInt('0x' + key);
  }

  /**
   * Find k closest peers to a key
   */
  findClosestPeers(key: string, count: number = this.config.k): DHTNode[] {
    const allPeers = this.getAllPeers();

    return allPeers
      .map((peer) => ({
        ...peer,
        distance: this.calculateDistance(key, peer.peerId),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, count);
  }

  /**
   * Get all peers from routing table
   */
  private getAllPeers(): DHTNode[] {
    const peers: DHTNode[] = [];
    for (const bucket of this.routingTable.values()) {
      peers.push(...bucket);
    }
    return peers;
  }

  /**
   * Add peer to routing table
   */
  addPeer(peerId: PeerId): void {
    const distance = this.calculateDistance(this.localPeerId, peerId);
    const bucketIndex = this.getBucketIndex(distance);

    const bucket = this.routingTable.get(bucketIndex.toString()) || [];

    // Check if peer already exists
    const existingIndex = bucket.findIndex((p) => p.peerId === peerId);
    if (existingIndex >= 0) {
      bucket[existingIndex].lastSeen = Date.now();
    } else {
      // Add new peer if bucket not full
      if (bucket.length < this.config.k) {
        bucket.push({
          peerId,
          lastSeen: Date.now(),
          distance,
        });
      } else {
        // Replace oldest peer if new peer is closer
        const oldest = bucket.reduce((oldest, p) => (p.lastSeen < oldest.lastSeen ? p : oldest));
        if (distance < oldest.distance) {
          const index = bucket.findIndex((p) => p.peerId === oldest.peerId);
          bucket[index] = {
            peerId,
            lastSeen: Date.now(),
            distance,
          };
        }
      }
    }

    this.routingTable.set(bucketIndex.toString(), bucket);
  }

  /**
   * Get bucket index for a distance
   */
  private getBucketIndex(distance: number): number {
    return Math.floor(Math.log2(distance || 1));
  }

  /**
   * Store data in DHT with real replication
   */
  async store(key: string, value: string, ttl: number = 86400000): Promise<void> {
    const entry: DHTEntry = {
      key,
      value,
      peerId: this.localPeerId,
      timestamp: Date.now(),
      expiresAt: Date.now() + ttl,
    };

    const existing = this.dataStore.get(key) || [];
    existing.push(entry);
    this.dataStore.set(key, existing);

    // Replicate to k closest peers using NetworkService
    const closestPeers = this.findClosestPeers(key);
    console.log(`[DHTService] Storing key ${key}, replicating to ${closestPeers.length} peers`);

    try {
      const networkService = getNetworkService();
      const peerManager = networkService.getPeerManager();

      if (peerManager && peerManager.isRunning()) {
        // Replicate to closest peers using libp2p streams
        for (const peer of closestPeers) {
          try {
            // Open stream to peer for DHT replication
            const streamId = await peerManager.openStream(peer.peerId, '/synpeer/dht/1.0.0');

            // Create DHT store packet
            const storePacket = {
              type: 'STORE',
              key,
              value,
              expiresAt: entry.expiresAt,
              timestamp: entry.timestamp,
            };

            // Send store packet through stream
            await peerManager.sendStreamData(streamId, encodeUtf8(JSON.stringify(storePacket)));

            // Close stream
            await peerManager.closeStream(streamId);

            console.log(`[DHTService] Replicated key ${key} to peer ${peer.peerId}`);
          } catch (error) {
            console.error(`[DHTService] Failed to replicate to peer ${peer.peerId}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('[DHTService] Failed to replicate data:', error);
    }
  }

  /**
   * Retrieve data from DHT
   */
  async retrieve(key: string): Promise<DHTEntry[]> {
    const entries = this.dataStore.get(key) || [];

    // Filter expired entries
    const now = Date.now();
    const validEntries = entries.filter((e) => e.expiresAt > now);

    // Update data store with only valid entries
    this.dataStore.set(key, validEntries);

    return validEntries;
  }

  /**
   * Remove peer from routing table
   */
  removePeer(peerId: PeerId): void {
    for (const [bucketIndex, bucket] of this.routingTable.entries()) {
      const index = bucket.findIndex((p) => p.peerId === peerId);
      if (index >= 0) {
        bucket.splice(index, 1);
        this.routingTable.set(bucketIndex, bucket);
        break;
      }
    }
  }

  /**
   * Clean expired entries
   */
  cleanExpiredEntries(): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, entries] of this.dataStore.entries()) {
      const validEntries = entries.filter((e) => e.expiresAt > now);
      removed += entries.length - validEntries.length;

      if (validEntries.length === 0) {
        this.dataStore.delete(key);
      } else {
        this.dataStore.set(key, validEntries);
      }
    }

    return removed;
  }

  /**
   * Clean stale peers from routing table
   */
  cleanStalePeers(threshold: number = 3600000): number {
    const now = Date.now();
    let removed = 0;

    for (const [bucketIndex, bucket] of this.routingTable.entries()) {
      const validPeers = bucket.filter((p) => now - p.lastSeen < threshold);
      removed += bucket.length - validPeers.length;

      if (validPeers.length === 0) {
        this.routingTable.delete(bucketIndex);
      } else {
        this.routingTable.set(bucketIndex, validPeers);
      }
    }

    return removed;
  }

  /**
   * Get routing table size
   */
  getRoutingTableSize(): number {
    return this.getAllPeers().length;
  }

  /**
   * Get data store size
   */
  getDataStoreSize(): number {
    let size = 0;
    for (const entries of this.dataStore.values()) {
      size += entries.length;
    }
    return size;
  }
}
