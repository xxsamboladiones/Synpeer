import type { PeerId } from '../network/NetworkTypes';
import type { ContributionEvent, ContributionEventType } from './ContributionTypes';
import { sha256Hex } from '../utils/hash';
import { canonicalize } from '../economy/Wallet/TransactionModel';
import type { Clock } from '../time/Clock';
import { systemClock } from '../time/Clock';
import { createLogger } from '../observability/Logger';

/**
 * ContributionEvents manages contribution event emission
 */
export class ContributionEvents {
  private events: ContributionEvent[] = [];
  private listeners: Map<ContributionEventType, Set<(event: ContributionEvent) => void>> =
    new Map();
  private allListeners: Set<(event: ContributionEvent) => void> = new Set();
  private readonly logger = createLogger('contribution.events');

  constructor(private readonly clock: Clock = systemClock) {}

  /**
   * Emit a contribution event
   */
  emit(
    type: ContributionEventType,
    peerId: PeerId,
    value: number,
    metadata?: Record<string, unknown>,
  ): ContributionEvent {
    const timestamp = this.clock.now();
    const id = this.createEventId(type, peerId, value, metadata);
    const existing = this.events.find((event) => event.id === id);
    if (existing) {
      return existing;
    }

    const event: ContributionEvent = {
      id,
      type,
      peerId,
      timestamp,
      value,
      metadata,
    };

    this.events.push(event);

    // Notify type-specific listeners
    const typeListeners = this.listeners.get(type);
    if (typeListeners) {
      for (const listener of typeListeners) {
        try {
          listener(event);
        } catch (error) {
          this.logger.error('listener_failed', error, { eventType: type });
        }
      }
    }

    // Notify all listeners
    for (const listener of this.allListeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error('listener_failed', error, { eventType: type });
      }
    }

    return event;
  }

  /**
   * Add listener for specific event type
   */
  on(type: ContributionEventType, listener: (event: ContributionEvent) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  /**
   * Add listener for all events
   */
  onAll(listener: (event: ContributionEvent) => void): void {
    this.allListeners.add(listener);
  }

  /**
   * Remove listener for specific event type
   */
  off(type: ContributionEventType, listener: (event: ContributionEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  /**
   * Remove listener for all events
   */
  offAll(listener: (event: ContributionEvent) => void): void {
    this.allListeners.delete(listener);
  }

  /**
   * Get events for a peer
   */
  getEventsForPeer(peerId: PeerId, limit?: number): ContributionEvent[] {
    const peerEvents = this.events.filter((e) => e.peerId === peerId);
    if (limit) {
      return peerEvents.slice(-limit);
    }
    return peerEvents;
  }

  /**
   * Get events by type
   */
  getEventsByType(type: ContributionEventType, limit?: number): ContributionEvent[] {
    const typeEvents = this.events.filter((e) => e.type === type);
    if (limit) {
      return typeEvents.slice(-limit);
    }
    return typeEvents;
  }

  /**
   * Get all events
   */
  getAllEvents(limit?: number): ContributionEvent[] {
    if (limit) {
      return this.events.slice(-limit);
    }
    return this.events;
  }

  /**
   * Get events in time range
   */
  getEventsInTimeRange(startTime: number, endTime: number): ContributionEvent[] {
    return this.events.filter((e) => e.timestamp >= startTime && e.timestamp <= endTime);
  }

  /**
   * Get total value for a peer
   */
  getTotalValueForPeer(peerId: PeerId): number {
    return this.events.filter((e) => e.peerId === peerId).reduce((sum, e) => sum + e.value, 0);
  }

  /**
   * Get total value by event type
   */
  getTotalValueByType(type: ContributionEventType): number {
    return this.events.filter((e) => e.type === type).reduce((sum, e) => sum + e.value, 0);
  }

  /**
   * Get event count for a peer
   */
  getEventCountForPeer(peerId: PeerId): number {
    return this.events.filter((e) => e.peerId === peerId).length;
  }

  /**
   * Get event count by type
   */
  getEventCountByType(type: ContributionEventType): number {
    return this.events.filter((e) => e.type === type).length;
  }

  /**
   * Clear all events
   */
  clearAll(): void {
    this.events = [];
  }

  /**
   * Clear events for a peer
   */
  clearForPeer(peerId: PeerId): void {
    this.events = this.events.filter((e) => e.peerId !== peerId);
  }

  /**
   * Clear events by type
   */
  clearByType(type: ContributionEventType): void {
    this.events = this.events.filter((e) => e.type !== type);
  }

  /**
   * Get total event count
   */
  getCount(): number {
    return this.events.length;
  }

  /**
   * Get listener count
   */
  getListenerCount(): number {
    let count = this.allListeners.size;
    for (const listeners of this.listeners.values()) {
      count += listeners.size;
    }
    return count;
  }

  /**
   * Remove all listeners
   */
  removeAllListeners(): void {
    this.listeners.clear();
    this.allListeners.clear();
  }

  private createEventId(
    type: ContributionEventType,
    peerId: PeerId,
    value: number,
    metadata?: Record<string, unknown>,
  ): string {
    return `event_${sha256Hex(
      canonicalize({
        type,
        peerId,
        value,
        metadata: metadata ?? null,
      }),
    ).slice(0, 32)}`;
  }
}
