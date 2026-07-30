import type { PeerId } from '../../network/NetworkTypes';
import { sha256Hex } from '../../utils/hash';

export interface OfflineQueueConfig {
  maxRetries: number;
  initialBackoff: number;
  maxBackoff: number;
  backoffMultiplier: number;
}

export interface QueueItem {
  id: string;
  operation: string;
  data: unknown;
  targetPeer?: PeerId;
  attempts: number;
  lastAttempt: number;
  nextAttempt: number;
  status: 'pending' | 'sending' | 'confirmed' | 'failed';
  version: string;
  updatedAt: number;
  signature?: string;
}

export type OfflineQueueHandler = (item: QueueItem) => Promise<void> | void;

/**
 * OfflineQueue manages operations when device is offline
 * Implements exponential backoff for retries
 */
export class OfflineQueue {
  private config: OfflineQueueConfig;
  private queue: Map<string, QueueItem>;
  private handlers: Map<string, OfflineQueueHandler>;
  private isProcessing: boolean = false;
  private processInterval: number | null = null;

  constructor(config: OfflineQueueConfig) {
    this.config = {
      maxRetries: config.maxRetries ?? 5,
      initialBackoff: config.initialBackoff ?? 5000,
      maxBackoff: config.maxBackoff ?? 300000,
      backoffMultiplier: config.backoffMultiplier ?? 2,
    };
    this.queue = new Map();
    this.handlers = new Map();
  }

  registerHandler(operation: string, handler: OfflineQueueHandler): () => void {
    this.handlers.set(operation, handler);
    return () => {
      if (this.handlers.get(operation) === handler) {
        this.handlers.delete(operation);
      }
    };
  }

  /**
   * Add operation to queue
   */
  add(operation: string, data: unknown, targetPeer?: PeerId): string {
    const now = Date.now();
    const id = `${operation}_${sha256Hex(`${operation}:${JSON.stringify(data)}:${targetPeer ?? 'broadcast'}:${now}`).slice(0, 24)}`;

    const item: QueueItem = {
      id,
      operation,
      data,
      targetPeer,
      attempts: 0,
      lastAttempt: 0,
      nextAttempt: now,
      status: 'pending',
      version: '1.0.0',
      updatedAt: now,
    };

    this.queue.set(id, item);
    console.log(`[OfflineQueue] Added operation ${operation} to queue`);

    return id;
  }

  /**
   * Add operation with versioning
   */
  addWithVersion(
    operation: string,
    data: unknown,
    version: string,
    signature: string,
    targetPeer?: PeerId,
  ): string {
    const id = this.add(operation, data, targetPeer);
    const item = this.queue.get(id);
    if (item) {
      item.version = version;
      item.signature = signature;
      this.queue.set(id, item);
    }
    return id;
  }

  /**
   * Start processing queue
   */
  startProcessing(): void {
    if (this.isProcessing) return;

    console.log('[OfflineQueue] Starting queue processing');
    this.isProcessing = true;
    this.processInterval = globalThis.setInterval(() => {
      this.processQueue();
    }, 1000) as unknown as number; // Check every second
  }

  /**
   * Stop processing queue
   */
  stopProcessing(): void {
    if (!this.isProcessing) return;

    console.log('[OfflineQueue] Stopping queue processing');

    if (this.processInterval) {
      globalThis.clearInterval(this.processInterval);
      this.processInterval = null;
    }

    this.isProcessing = false;
  }

  /**
   * Process queue
   */
  private async processQueue(): Promise<void> {
    const now = Date.now();
    const pendingItems = Array.from(this.queue.values()).filter(
      (item) => item.status === 'pending' && item.nextAttempt <= now,
    );

    for (const item of pendingItems) {
      await this.processItem(item);
    }
  }

  /**
   * Process single item
   */
  private async processItem(item: QueueItem): Promise<void> {
    item.status = 'sending';
    item.lastAttempt = Date.now();
    item.attempts++;
    this.queue.set(item.id, item);

    try {
      const handler = this.handlers.get(item.operation);
      if (!handler) {
        throw new Error(`No offline queue handler registered for operation ${item.operation}`);
      }

      await handler(item);
      item.status = 'confirmed';
      item.updatedAt = Date.now();
      this.queue.set(item.id, item);
    } catch (error) {
      console.error(`[OfflineQueue] Failed to process ${item.operation}:`, error);

      if (item.attempts >= this.config.maxRetries) {
        item.status = 'failed';
      } else {
        item.status = 'pending';
        item.nextAttempt = this.calculateNextAttempt(item.attempts);
      }
      item.updatedAt = Date.now();

      this.queue.set(item.id, item);
    }
  }

  /**
   * Calculate next attempt time with exponential backoff
   */
  private calculateNextAttempt(attempts: number): number {
    const backoff = Math.min(
      this.config.maxBackoff,
      this.config.initialBackoff * Math.pow(this.config.backoffMultiplier, attempts - 1),
    );
    return Date.now() + backoff;
  }

  /**
   * Get item by ID
   */
  getItem(id: string): QueueItem | undefined {
    return this.queue.get(id);
  }

  /**
   * Get all items
   */
  getAllItems(): QueueItem[] {
    return Array.from(this.queue.values());
  }

  /**
   * Get items by status
   */
  getItemsByStatus(status: QueueItem['status']): QueueItem[] {
    return Array.from(this.queue.values()).filter((item) => item.status === status);
  }

  /**
   * Mark item as confirmed
   */
  markConfirmed(id: string): void {
    const item = this.queue.get(id);
    if (item) {
      item.status = 'confirmed';
      this.queue.set(id, item);
    }
  }

  /**
   * Mark item as failed
   */
  markFailed(id: string): void {
    const item = this.queue.get(id);
    if (item) {
      item.status = 'failed';
      this.queue.set(id, item);
    }
  }

  /**
   * Retry item
   */
  retryItem(id: string): void {
    const item = this.queue.get(id);
    if (item) {
      item.status = 'pending';
      item.attempts = 0;
      item.nextAttempt = Date.now();
      this.queue.set(id, item);
    }
  }

  /**
   * Remove item
   */
  removeItem(id: string): void {
    this.queue.delete(id);
  }

  /**
   * Clean confirmed items
   */
  cleanConfirmed(): number {
    let removed = 0;
    for (const [id, item] of this.queue.entries()) {
      if (item.status === 'confirmed') {
        this.queue.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Clean failed items
   */
  cleanFailed(): number {
    let removed = 0;
    for (const [id, item] of this.queue.entries()) {
      if (item.status === 'failed') {
        this.queue.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Get queue status
   */
  getStatus(): { pending: number; sending: number; confirmed: number; failed: number } {
    const items = Array.from(this.queue.values());
    return {
      pending: items.filter((i) => i.status === 'pending').length,
      sending: items.filter((i) => i.status === 'sending').length,
      confirmed: items.filter((i) => i.status === 'confirmed').length,
      failed: items.filter((i) => i.status === 'failed').length,
    };
  }

  /**
   * Get queue size
   */
  getSize(): number {
    return this.queue.size;
  }

  /**
   * Clear queue
   */
  clear(): void {
    this.queue.clear();
  }
}
