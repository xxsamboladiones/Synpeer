import type { PeerId } from '../network/NetworkTypes';

/**
 * Contribution proof
 */
export interface ContributionProof {
  contributionId: string;
  contributor: PeerId;
  category: RewardCategory;
  value: number;
  timestamp: number;
  trustScore: number;
  approvalPercentage: number;
  quorumReached: boolean;
  evidence: {
    hash: string;
  };
  votes: unknown[];
  hash: string;
}

/**
 * Reward categories
 */
export type RewardCategory =
  'STORAGE' | 'BANDWIDTH' | 'STREAMING' | 'REPLICATION' | 'AVAILABILITY' | 'COMMUNITY';

/**
 * Transaction types
 */
export type TransactionType = 'REWARD' | 'TRANSFER' | 'PENALTY' | 'BONUS' | 'STAKE' | 'UNSTAKE';

/**
 * Transaction status
 */
export type TransactionStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'CANCELLED';

/**
 * Wallet state
 */
export interface Wallet {
  address: string;
  peerId: PeerId;
  balance: number;
  nonce: number;
  version: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Transaction
 */
export interface Transaction {
  id: string;
  type: TransactionType;
  from: string;
  to: string;
  amount: number;
  fee: number;
  timestamp: number;
  status: TransactionStatus;
  category?: RewardCategory;
  description?: string;
  signature?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Reward
 */
export interface Reward {
  id: string;
  proofBundleId: string;
  recipient: PeerId;
  amount: number;
  category: RewardCategory;
  timestamp: number;
  status: TransactionStatus;
  bonus: number;
  penalty: number;
  netAmount: number;
}

/**
 * Reward pool configuration
 */
export interface RewardPoolConfig {
  category: RewardCategory;
  weight: number; // 0-1
  dailyLimit: number;
  perPeerLimit: number;
  enabled: boolean;
}

/**
 * Inflation control configuration
 */
export interface InflationConfig {
  maxSupply: number;
  annualReduction: number; // percentage
  dailyLimit: number;
  perPeerLimit: number;
  currentSupply: number;
  year: number;
}

/**
 * Reward schedule entry
 */
export interface RewardScheduleEntry {
  year: number;
  totalEmission: number;
  monthlyEmission: number;
  dailyEmission: number;
  reductionRate: number;
}

/**
 * Ledger entry
 */
export interface LedgerEntry {
  id: string;
  walletAddress: string;
  amount: number;
  type: TransactionType;
  category?: RewardCategory;
  description: string;
  timestamp: number;
  balance: number;
  metadata?: Record<string, unknown>;
}

/**
 * Ledger snapshot
 */
export interface LedgerSnapshot {
  id: string;
  timestamp: number;
  totalSupply: number;
  totalWallets: number;
  totalTransactions: number;
  rootHash: string;
  previousSnapshotId?: string;
}

/**
 * Economy statistics
 */
export interface EconomyStatistics {
  totalSupply: number;
  totalWallets: number;
  totalTransactions: number;
  totalRewards: number;
  totalPenalties: number;
  averageBalance: number;
  dailyRewards: number;
  weeklyRewards: number;
  monthlyRewards: number;
  inflationRate: number;
  lastUpdated: number;
}

/**
 * Default reward pool weights
 */
export const defaultRewardPoolWeights: Record<RewardCategory, number> = {
  STORAGE: 0.3,
  BANDWIDTH: 0.25,
  STREAMING: 0.15,
  REPLICATION: 0.15,
  AVAILABILITY: 0.1,
  COMMUNITY: 0.05,
};

/**
 * Default inflation configuration
 */
export const defaultInflationConfig: InflationConfig = {
  maxSupply: 1000000000, // 1 billion tokens
  annualReduction: 0.2, // 20% reduction per year
  dailyLimit: 1000000, // 1 million tokens per day
  perPeerLimit: 1000, // 1000 tokens per peer per day
  currentSupply: 0,
  year: 1,
};

/**
 * Default reward schedule (10 years)
 */
export const defaultRewardSchedule: RewardScheduleEntry[] = [
  {
    year: 1,
    totalEmission: 100000000,
    monthlyEmission: 8333333,
    dailyEmission: 273972,
    reductionRate: 0,
  },
  {
    year: 2,
    totalEmission: 80000000,
    monthlyEmission: 6666666,
    dailyEmission: 219178,
    reductionRate: 0.2,
  },
  {
    year: 3,
    totalEmission: 64000000,
    monthlyEmission: 5333333,
    dailyEmission: 175342,
    reductionRate: 0.2,
  },
  {
    year: 4,
    totalEmission: 51200000,
    monthlyEmission: 4266666,
    dailyEmission: 140274,
    reductionRate: 0.2,
  },
  {
    year: 5,
    totalEmission: 40960000,
    monthlyEmission: 3413333,
    dailyEmission: 112219,
    reductionRate: 0.2,
  },
  {
    year: 6,
    totalEmission: 32768000,
    monthlyEmission: 2730666,
    dailyEmission: 89775,
    reductionRate: 0.2,
  },
  {
    year: 7,
    totalEmission: 26214400,
    monthlyEmission: 2184533,
    dailyEmission: 71820,
    reductionRate: 0.2,
  },
  {
    year: 8,
    totalEmission: 20971520,
    monthlyEmission: 1747626,
    dailyEmission: 57456,
    reductionRate: 0.2,
  },
  {
    year: 9,
    totalEmission: 16777216,
    monthlyEmission: 1398101,
    dailyEmission: 45965,
    reductionRate: 0.2,
  },
  {
    year: 10,
    totalEmission: 13421772,
    monthlyEmission: 1118481,
    dailyEmission: 36772,
    reductionRate: 0.2,
  },
];
