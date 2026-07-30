import type { PeerId } from '@/network/NetworkTypes';
import type { StorageService } from '@/services/storage/StorageService';

import type {
  PeerSessionState,
  PeerTrustIdentity,
  TrustedPeer,
  TrustedPeerProjection,
  TrustedPeerSource,
  TrustedPeerStatus,
} from './TrustedPeerTypes';

const STORAGE_KEY = 'trusted_peers';
const REMOVED_STORAGE_KEY = 'trusted_peers_removed';

type TrustedPeerRecord = Record<PeerId, TrustedPeer>;
type RemovedTrustedPeerRecord = Record<PeerId, number>;

export class TrustedPeerRepository {
  constructor(private readonly storage: StorageService) {}

  list(): TrustedPeer[] {
    return Object.values(this.readAll()).sort((left, right) => right.updatedAt - left.updatedAt);
  }

  get(peerId: PeerId): TrustedPeer | null {
    return this.readAll()[peerId] ?? null;
  }

  upsert(input: {
    peerId: PeerId;
    addresses?: string[];
    identityId?: string;
    displayName?: string;
    publicKey?: string;
    trustStatus?: TrustedPeerStatus;
    source?: TrustedPeerSource;
  }): TrustedPeer {
    this.forgetRemoved(input.peerId);
    const peers = this.readAll();
    const existing = peers[input.peerId];
    const now = Date.now();
    const addresses = this.mergeAddresses(existing?.addresses ?? [], input.addresses ?? []);

    const peer: TrustedPeer = {
      peerId: input.peerId,
      identityId: input.identityId ?? existing?.identityId,
      displayName: input.displayName ?? existing?.displayName,
      publicKey: input.publicKey ?? existing?.publicKey,
      addresses,
      trustStatus: input.trustStatus ?? existing?.trustStatus ?? 'unknown',
      lastSeenAt: existing?.lastSeenAt,
      lastConnectedAt: existing?.lastConnectedAt,
      lastSyncAt: existing?.lastSyncAt,
      addedAt: existing?.addedAt ?? now,
      updatedAt: now,
      source: input.source ?? existing?.source ?? 'manual',
      syncedObjects: existing?.syncedObjects ?? 0,
      sessionState: existing?.sessionState ?? 'unknown',
      lastHandshakeAt: existing?.lastHandshakeAt,
      activeSessionId: existing?.activeSessionId,
      syncCursor: existing?.syncCursor,
      projection: existing?.projection,
    };

    peers[input.peerId] = peer;
    this.writeAll(peers);
    return peer;
  }

  markVerified(peerId: PeerId, identity: PeerTrustIdentity): TrustedPeer {
    const existing = this.get(peerId);
    if (existing?.trustStatus === 'blocked') {
      return existing;
    }

    return this.upsert({
      peerId,
      identityId: identity.identityId,
      displayName: identity.displayName,
      publicKey: identity.publicKey,
      trustStatus: 'verified',
      source: existing?.source ?? 'discovery',
    });
  }

  markBlocked(peerId: PeerId): TrustedPeer | null {
    const existing = this.get(peerId);
    if (!existing) {
      return null;
    }

    const peer = {
      ...existing,
      trustStatus: 'blocked' as const,
      sessionState: 'blocked' as const,
      updatedAt: Date.now(),
    };
    const peers = this.readAll();
    peers[peerId] = peer;
    this.writeAll(peers);
    return peer;
  }

  markUnknown(peerId: PeerId): TrustedPeer | null {
    const existing = this.get(peerId);
    if (!existing) {
      return null;
    }

    const peer = { ...existing, trustStatus: 'unknown' as const, updatedAt: Date.now() };
    const peers = this.readAll();
    peers[peerId] = peer;
    this.writeAll(peers);
    return peer;
  }

  remove(peerId: PeerId): void {
    const peers = this.readAll();
    delete peers[peerId];
    this.writeAll(peers);
    this.rememberRemoved(peerId);
  }

  isRemoved(peerId: PeerId): boolean {
    return Boolean(this.readRemoved()[peerId]);
  }

  forgetRemoved(peerId: PeerId): void {
    const removed = this.readRemoved();
    if (!removed[peerId]) {
      return;
    }
    delete removed[peerId];
    this.writeRemoved(removed);
  }

  clear(): void {
    this.storage.remove(STORAGE_KEY);
    this.storage.remove(REMOVED_STORAGE_KEY);
  }

  recordConnection(peerId: PeerId): void {
    const existing = this.get(peerId);
    if (!existing) {
      return;
    }

    const now = Date.now();
    const peers = this.readAll();
    peers[peerId] = {
      ...existing,
      lastSeenAt: now,
      lastConnectedAt: now,
      updatedAt: now,
    };
    this.writeAll(peers);
  }

  updateSessionState(
    peerId: PeerId,
    state: PeerSessionState,
    options: { sessionId?: string; reason?: string } = {},
  ): TrustedPeer | null {
    const existing = this.get(peerId);
    if (!existing) {
      return null;
    }

    const now = Date.now();
    const peers = this.readAll();
    peers[peerId] = {
      ...existing,
      sessionState: existing.trustStatus === 'blocked' ? 'blocked' : state,
      activeSessionId: options.sessionId ?? existing.activeSessionId,
      projection:
        state === 'failed'
          ? this.updateProjection(existing.projection, false, options.reason, now)
          : existing.projection,
      updatedAt: now,
    };
    this.writeAll(peers);
    return peers[peerId];
  }

  recordHandshakeSuccess(peerId: PeerId, sessionId?: string): TrustedPeer {
    const existing = this.get(peerId) ?? this.upsert({ peerId, source: 'discovery' });
    const now = Date.now();
    const peers = this.readAll();
    const peer: TrustedPeer = {
      ...existing,
      sessionState: 'verified',
      lastHandshakeAt: now,
      activeSessionId: sessionId ?? existing.activeSessionId,
      projection: this.updateProjection(existing.projection, true, undefined, now),
      updatedAt: now,
    };
    peers[peerId] = peer;
    this.writeAll(peers);
    return peer;
  }

  recordSyncCursor(peerId: PeerId, cursor: string | undefined, syncedObjects: number): void {
    const existing = this.get(peerId);
    if (!existing) {
      return;
    }
    const now = Date.now();
    const peers = this.readAll();
    peers[peerId] = {
      ...existing,
      lastSyncAt: now,
      syncedObjects: existing.syncedObjects + Math.max(0, syncedObjects),
      syncCursor: cursor ?? existing.syncCursor,
      updatedAt: now,
    };
    this.writeAll(peers);
  }

  recordSync(peerId: PeerId, syncedObjects: number): void {
    const existing = this.get(peerId);
    if (!existing) {
      return;
    }

    const now = Date.now();
    const peers = this.readAll();
    peers[peerId] = {
      ...existing,
      lastSyncAt: now,
      syncedObjects: existing.syncedObjects + Math.max(0, syncedObjects),
      updatedAt: now,
    };
    this.writeAll(peers);
  }

  private readAll(): TrustedPeerRecord {
    return this.storage.getJson<TrustedPeerRecord>(STORAGE_KEY) ?? {};
  }

  private writeAll(peers: TrustedPeerRecord): void {
    this.storage.setJson(STORAGE_KEY, peers);
  }

  private readRemoved(): RemovedTrustedPeerRecord {
    return this.storage.getJson<RemovedTrustedPeerRecord>(REMOVED_STORAGE_KEY) ?? {};
  }

  private writeRemoved(peers: RemovedTrustedPeerRecord): void {
    this.storage.setJson(REMOVED_STORAGE_KEY, peers);
  }

  private rememberRemoved(peerId: PeerId): void {
    const removed = this.readRemoved();
    removed[peerId] = Date.now();
    this.writeRemoved(removed);
  }

  private mergeAddresses(existing: string[], incoming: string[]): string[] {
    return Array.from(
      new Set([...existing, ...incoming].map((address) => address.trim()).filter(Boolean)),
    );
  }

  private updateProjection(
    existing: TrustedPeerProjection | undefined,
    success: boolean,
    failureReason: string | undefined,
    now: number,
  ): TrustedPeerProjection {
    const successfulHandshakes = (existing?.successfulHandshakes ?? 0) + (success ? 1 : 0);
    const failedHandshakes = (existing?.failedHandshakes ?? 0) + (success ? 0 : 1);
    const attempts = successfulHandshakes + failedHandshakes;
    const trustScore = attempts === 0 ? 0 : Math.round((successfulHandshakes / attempts) * 100);
    return {
      trustScore,
      successfulHandshakes,
      failedHandshakes,
      lastFailureReason: success ? existing?.lastFailureReason : failureReason,
      lastProjectedAt: now,
    };
  }
}
