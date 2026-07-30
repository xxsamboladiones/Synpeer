import type { LedgerEntry, LedgerSnapshot, TransactionType, RewardCategory } from '../RewardTypes';

/**
 * Ledger Engine manages local ledger operations
 */
export class LedgerEngine {
  private entries: Map<string, LedgerEntry> = new Map();
  private snapshots: Map<string, LedgerSnapshot> = new Map();
  private walletBalances: Map<string, number> = new Map();
  private totalSupply: number = 0;
  private entryCounter: number = 0;
  private snapshotCounter: number = 0;

  /**
   * Add entry to ledger
   */
  addEntry(
    walletAddress: string,
    amount: number,
    type: TransactionType,
    description: string,
    category?: RewardCategory,
    metadata?: Record<string, unknown>,
  ): LedgerEntry {
    const currentBalance = this.walletBalances.get(walletAddress) || 0;
    const newBalance = currentBalance + amount;

    const entry: LedgerEntry = {
      id: this.generateEntryId(),
      walletAddress,
      amount,
      type,
      category,
      description,
      timestamp: Date.now(),
      balance: newBalance,
      metadata,
    };

    this.entries.set(entry.id, entry);
    this.walletBalances.set(walletAddress, newBalance);
    this.totalSupply += amount;

    return entry;
  }

  /**
   * Get entry by ID
   */
  getEntry(id: string): LedgerEntry | null {
    return this.entries.get(id) || null;
  }

  /**
   * Get entries for wallet
   */
  getEntriesForWallet(walletAddress: string, limit?: number): LedgerEntry[] {
    const walletEntries = Array.from(this.entries.values()).filter(
      (e) => e.walletAddress === walletAddress,
    );

    if (limit) {
      return walletEntries.slice(-limit);
    }

    return walletEntries;
  }

  /**
   * Get entries by type
   */
  getEntriesByType(type: TransactionType, limit?: number): LedgerEntry[] {
    const typeEntries = Array.from(this.entries.values()).filter((e) => e.type === type);

    if (limit) {
      return typeEntries.slice(-limit);
    }

    return typeEntries;
  }

  /**
   * Get entries by category
   */
  getEntriesByCategory(category: RewardCategory, limit?: number): LedgerEntry[] {
    const categoryEntries = Array.from(this.entries.values()).filter(
      (e) => e.category === category,
    );

    if (limit) {
      return categoryEntries.slice(-limit);
    }

    return categoryEntries;
  }

  /**
   * Get all entries
   */
  getAllEntries(limit?: number): LedgerEntry[] {
    const allEntries = Array.from(this.entries.values());

    if (limit) {
      return allEntries.slice(-limit);
    }

    return allEntries;
  }

  /**
   * Get wallet balance
   */
  getBalance(walletAddress: string): number {
    return this.walletBalances.get(walletAddress) || 0;
  }

  /**
   * Get total supply
   */
  getTotalSupply(): number {
    return this.totalSupply;
  }

  /**
   * Create snapshot
   */
  createSnapshot(): LedgerSnapshot {
    const snapshot: LedgerSnapshot = {
      id: this.generateSnapshotId(),
      timestamp: Date.now(),
      totalSupply: this.totalSupply,
      totalWallets: this.walletBalances.size,
      totalTransactions: this.entries.size,
      rootHash: this.calculateRootHash(),
      previousSnapshotId: this.getLatestSnapshotId(),
    };

    this.snapshots.set(snapshot.id, snapshot);
    return snapshot;
  }

  /**
   * Get snapshot by ID
   */
  getSnapshot(id: string): LedgerSnapshot | null {
    return this.snapshots.get(id) || null;
  }

  /**
   * Get latest snapshot
   */
  getLatestSnapshot(): LedgerSnapshot | null {
    const snapshots = Array.from(this.snapshots.values());
    if (snapshots.length === 0) {
      return null;
    }

    return snapshots.sort((a, b) => b.timestamp - a.timestamp)[0];
  }

  /**
   * Get all snapshots
   */
  getAllSnapshots(limit?: number): LedgerSnapshot[] {
    const allSnapshots = Array.from(this.snapshots.values());

    if (limit) {
      return allSnapshots.slice(-limit);
    }

    return allSnapshots;
  }

  /**
   * Generate entry ID
   */
  private generateEntryId(): string {
    this.entryCounter++;
    return `ledger_entry_${Date.now()}_${this.entryCounter}`;
  }

  /**
   * Generate snapshot ID
   */
  private generateSnapshotId(): string {
    this.snapshotCounter++;
    return `snapshot_${Date.now()}_${this.snapshotCounter}`;
  }

  /**
   * Get latest snapshot ID
   */
  private getLatestSnapshotId(): string | undefined {
    const latest = this.getLatestSnapshot();
    return latest?.id;
  }

  /**
   * Calculate root hash
   */
  private calculateRootHash(): string {
    const entryIds = Array.from(this.entries.keys()).sort();
    const data = entryIds.join('');

    // Simple hash for now - in production, use SHA-256
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Verify ledger integrity
   */
  verifyIntegrity(): boolean {
    const calculatedTotal = Array.from(this.walletBalances.values()).reduce(
      (sum, balance) => sum + balance,
      0,
    );
    return calculatedTotal === this.totalSupply;
  }

  /**
   * Get entry count
   */
  getEntryCount(): number {
    return this.entries.size;
  }

  /**
   * Get snapshot count
   */
  getSnapshotCount(): number {
    return this.snapshots.size;
  }

  /**
   * Get wallet count
   */
  getWalletCount(): number {
    return this.walletBalances.size;
  }

  /**
   * Clear all entries
   */
  clearEntries(): void {
    this.entries.clear();
    this.walletBalances.clear();
    this.totalSupply = 0;
  }

  /**
   * Clear all snapshots
   */
  clearSnapshots(): void {
    this.snapshots.clear();
  }

  /**
   * Clear all
   */
  clearAll(): void {
    this.clearEntries();
    this.clearSnapshots();
  }

  /**
   * Export ledger to JSON
   */
  exportToJSON(): string {
    return JSON.stringify(
      {
        entries: Array.from(this.entries.values()),
        snapshots: Array.from(this.snapshots.values()),
        walletBalances: Array.from(this.walletBalances.entries()),
        totalSupply: this.totalSupply,
      },
      null,
      2,
    );
  }

  /**
   * Import ledger from JSON
   */
  importFromJSON(json: string): void {
    try {
      const data = JSON.parse(json) as {
        entries?: LedgerEntry[];
        snapshots?: LedgerSnapshot[];
        walletBalances?: [string, number][];
        totalSupply?: number;
      };

      if (data.entries) {
        for (const entry of data.entries) {
          this.entries.set(entry.id, entry);
        }
      }

      if (data.snapshots) {
        for (const snapshot of data.snapshots) {
          this.snapshots.set(snapshot.id, snapshot);
        }
      }

      if (data.walletBalances) {
        for (const [address, balance] of data.walletBalances) {
          this.walletBalances.set(address, balance);
        }
      }

      if (data.totalSupply !== undefined) {
        this.totalSupply = data.totalSupply;
      }
    } catch (error) {
      console.error('[LedgerEngine] Failed to import from JSON:', error);
    }
  }

  /**
   * Get statistics
   */
  getStatistics(): {
    totalEntries: number;
    totalSnapshots: number;
    totalWallets: number;
    totalSupply: number;
    averageBalance: number;
  } {
    const balances = Array.from(this.walletBalances.values());
    const averageBalance =
      balances.length > 0 ? balances.reduce((sum, b) => sum + b, 0) / balances.length : 0;

    return {
      totalEntries: this.entries.size,
      totalSnapshots: this.snapshots.size,
      totalWallets: this.walletBalances.size,
      totalSupply: this.totalSupply,
      averageBalance,
    };
  }
}
