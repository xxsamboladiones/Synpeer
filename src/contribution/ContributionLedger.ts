import type { PeerId } from '../network/NetworkTypes';
import type { LedgerEntry, ContributionEventType } from './ContributionTypes';
import { sha256Hex } from '../utils/hash';
import { canonicalize } from '../economy/Wallet/TransactionModel';
import type { Clock } from '../time/Clock';
import { systemClock } from '../time/Clock';
import { createLogger } from '../observability/Logger';

export type LedgerAppendResult =
  | { inserted: true; entry: LedgerEntry }
  | { inserted: false; reason: 'duplicate'; entry: LedgerEntry }
  | { inserted: false; reason: 'conflict'; existing: LedgerEntry };

/**
 * ContributionLedger manages local contribution history
 */
export class ContributionLedger {
  private entries: Map<string, LedgerEntry> = new Map();
  private readonly logger = createLogger('contribution.ledger');

  constructor(private readonly clock: Clock = systemClock) {}

  /**
   * Add a ledger entry
   */
  addEntry(
    peerId: PeerId,
    eventType: ContributionEventType,
    value: number,
    description: string,
    metadata?: Record<string, unknown>,
  ): LedgerEntry {
    const result = this.appendEntry(peerId, eventType, value, description, metadata);
    return result.inserted || result.reason === 'duplicate' ? result.entry : result.existing;
  }

  appendEntry(
    peerId: PeerId,
    eventType: ContributionEventType,
    value: number,
    description: string,
    metadata?: Record<string, unknown>,
  ): LedgerAppendResult {
    const timestamp = this.clock.now();
    const id = this.createEntryId(peerId, eventType, value, description, metadata);
    const entry: LedgerEntry = {
      id,
      peerId,
      eventType,
      timestamp,
      value,
      description,
      metadata,
    };

    const existing = this.entries.get(entry.id);
    if (existing) {
      if (this.entriesEqual(existing, entry)) {
        return { inserted: false, reason: 'duplicate', entry: existing };
      }
      return { inserted: false, reason: 'conflict', existing };
    }

    this.entries.set(entry.id, entry);
    return { inserted: true, entry };
  }

  /**
   * Get entry by ID
   */
  getEntry(id: string): LedgerEntry | null {
    return this.entries.get(id) || null;
  }

  /**
   * Get entries for a peer
   */
  getEntriesForPeer(peerId: PeerId, limit?: number): LedgerEntry[] {
    const peerEntries = Array.from(this.entries.values())
      .filter((e) => e.peerId === peerId)
      .sort((a, b) => b.timestamp - a.timestamp);

    if (limit) {
      return peerEntries.slice(0, limit);
    }
    return peerEntries;
  }

  /**
   * Get entries by event type
   */
  getEntriesByType(eventType: ContributionEventType, limit?: number): LedgerEntry[] {
    const typeEntries = Array.from(this.entries.values())
      .filter((e) => e.eventType === eventType)
      .sort((a, b) => b.timestamp - a.timestamp);

    if (limit) {
      return typeEntries.slice(0, limit);
    }
    return typeEntries;
  }

  /**
   * Get entries in time range
   */
  getEntriesInTimeRange(startTime: number, endTime: number): LedgerEntry[] {
    return Array.from(this.entries.values())
      .filter((e) => e.timestamp >= startTime && e.timestamp <= endTime)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Get entries for a peer in time range
   */
  getEntriesForPeerInTimeRange(peerId: PeerId, startTime: number, endTime: number): LedgerEntry[] {
    return Array.from(this.entries.values())
      .filter((e) => e.peerId === peerId && e.timestamp >= startTime && e.timestamp <= endTime)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Get all entries
   */
  getAllEntries(limit?: number): LedgerEntry[] {
    const allEntries = Array.from(this.entries.values()).sort((a, b) => b.timestamp - a.timestamp);

    if (limit) {
      return allEntries.slice(0, limit);
    }
    return allEntries;
  }

  /**
   * Get total value for a peer
   */
  getTotalValueForPeer(peerId: PeerId): number {
    return Array.from(this.entries.values())
      .filter((e) => e.peerId === peerId)
      .reduce((sum, e) => sum + e.value, 0);
  }

  /**
   * Get total value by event type
   */
  getTotalValueByType(eventType: ContributionEventType): number {
    return Array.from(this.entries.values())
      .filter((e) => e.eventType === eventType)
      .reduce((sum, e) => sum + e.value, 0);
  }

  /**
   * Get total value for a peer by event type
   */
  getTotalValueForPeerByType(peerId: PeerId, eventType: ContributionEventType): number {
    return Array.from(this.entries.values())
      .filter((e) => e.peerId === peerId && e.eventType === eventType)
      .reduce((sum, e) => sum + e.value, 0);
  }

  /**
   * Get entry count for a peer
   */
  getEntryCountForPeer(peerId: PeerId): number {
    return Array.from(this.entries.values()).filter((e) => e.peerId === peerId).length;
  }

  /**
   * Get entry count by event type
   */
  getEntryCountByType(eventType: ContributionEventType): number {
    return Array.from(this.entries.values()).filter((e) => e.eventType === eventType).length;
  }

  /**
   * Get daily summary for a peer
   */
  getDailySummaryForPeer(peerId: PeerId, date: Date): Map<ContributionEventType, number> {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const startTime = startOfDay.getTime();
    const endTime = endOfDay.getTime();

    const dailyEntries = this.getEntriesForPeerInTimeRange(peerId, startTime, endTime);
    const summary = new Map<ContributionEventType, number>();

    for (const entry of dailyEntries) {
      const current = summary.get(entry.eventType) || 0;
      summary.set(entry.eventType, current + entry.value);
    }

    return summary;
  }

  /**
   * Get weekly summary for a peer
   */
  getWeeklySummaryForPeer(peerId: PeerId, date: Date): Map<ContributionEventType, number> {
    const startOfWeek = new Date(date);
    startOfWeek.setDate(date.getDate() - date.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    endOfWeek.setHours(23, 59, 59, 999);

    const startTime = startOfWeek.getTime();
    const endTime = endOfWeek.getTime();

    const weeklyEntries = this.getEntriesForPeerInTimeRange(peerId, startTime, endTime);
    const summary = new Map<ContributionEventType, number>();

    for (const entry of weeklyEntries) {
      const current = summary.get(entry.eventType) || 0;
      summary.set(entry.eventType, current + entry.value);
    }

    return summary;
  }

  /**
   * Get monthly summary for a peer
   */
  getMonthlySummaryForPeer(peerId: PeerId, date: Date): Map<ContributionEventType, number> {
    const startOfMonth = new Date(date.getFullYear(), date.getMonth(), 1);
    startOfMonth.setHours(0, 0, 0, 0);

    const endOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    endOfMonth.setHours(23, 59, 59, 999);

    const startTime = startOfMonth.getTime();
    const endTime = endOfMonth.getTime();

    const monthlyEntries = this.getEntriesForPeerInTimeRange(peerId, startTime, endTime);
    const summary = new Map<ContributionEventType, number>();

    for (const entry of monthlyEntries) {
      const current = summary.get(entry.eventType) || 0;
      summary.set(entry.eventType, current + entry.value);
    }

    return summary;
  }

  /**
   * Delete entry by ID
   */
  deleteEntry(id: string): boolean {
    return this.entries.delete(id);
  }

  /**
   * Delete entries for a peer
   */
  deleteEntriesForPeer(peerId: PeerId): number {
    let count = 0;
    for (const [id, entry] of this.entries.entries()) {
      if (entry.peerId === peerId) {
        this.entries.delete(id);
        count++;
      }
    }
    return count;
  }

  /**
   * Delete entries by event type
   */
  deleteEntriesByType(eventType: ContributionEventType): number {
    let count = 0;
    for (const [id, entry] of this.entries.entries()) {
      if (entry.eventType === eventType) {
        this.entries.delete(id);
        count++;
      }
    }
    return count;
  }

  /**
   * Clear all entries
   */
  clearAll(): void {
    this.entries.clear();
  }

  /**
   * Get total entry count
   */
  getCount(): number {
    return this.entries.size;
  }

  /**
   * Export ledger to JSON
   */
  exportToJSON(): string {
    const entries = Array.from(this.entries.values());
    return JSON.stringify(entries, null, 2);
  }

  /**
   * Import ledger from JSON
   */
  importFromJSON(json: string): void {
    try {
      const entries = JSON.parse(json) as LedgerEntry[];
      for (const entry of entries) {
        if (this.isLedgerEntry(entry)) {
          const existing = this.entries.get(entry.id);
          if (!existing) {
            this.entries.set(entry.id, entry);
          }
        }
      }
    } catch (error) {
      this.logger.error('import_failed', error);
    }
  }

  private createEntryId(
    peerId: PeerId,
    eventType: ContributionEventType,
    value: number,
    description: string,
    metadata?: Record<string, unknown>,
  ): string {
    const explicitId = typeof metadata?.eventId === 'string' ? metadata.eventId : undefined;
    if (explicitId) {
      return `ledger_${sha256Hex(canonicalize({ eventId: explicitId })).slice(0, 32)}`;
    }
    return `ledger_${sha256Hex(
      canonicalize({
        peerId,
        eventType,
        value,
        description,
        metadata: metadata ?? null,
      }),
    ).slice(0, 32)}`;
  }

  private entriesEqual(left: LedgerEntry, right: LedgerEntry): boolean {
    return canonicalize({ ...left, timestamp: 0 }) === canonicalize({ ...right, timestamp: 0 });
  }

  private isLedgerEntry(value: unknown): value is LedgerEntry {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const entry = value as Record<string, unknown>;
    return (
      typeof entry.id === 'string' &&
      typeof entry.peerId === 'string' &&
      typeof entry.eventType === 'string' &&
      typeof entry.timestamp === 'number' &&
      typeof entry.value === 'number' &&
      typeof entry.description === 'string'
    );
  }
}
