import type { PeerId } from '../network/NetworkTypes';

/**
 * Contribution event types
 */
export type ContributionEventType =
  | 'STORAGE_SHARED'
  | 'BANDWIDTH_SHARED'
  | 'CHUNK_SERVED'
  | 'CHUNK_DOWNLOADED'
  | 'POST_REPLICATED'
  | 'MEDIA_REPLICATED'
  | 'UPTIME'
  | 'PEER_CONNECTED'
  | 'PEER_DISCONNECTED'
  | 'UPLOAD_FINISHED'
  | 'DOWNLOAD_FINISHED'
  | 'REQUEST_RECEIVED'
  | 'DATA_VALIDATED'
  | 'INVALID_DATA'
  | 'SYBIL_DETECTED'
  | 'MANIPULATION_DETECTED';

/**
 * Contribution event data
 */
export interface ContributionEvent {
  id: string;
  type: ContributionEventType;
  peerId: PeerId;
  timestamp: number;
  value: number; // Contribution value (points, bytes, etc.)
  metadata?: Record<string, unknown>;
}

/**
 * Contribution metrics
 */
export interface ContributionMetrics {
  peerId: PeerId;
  storageShared: number; // Bytes
  bandwidthShared: number; // Bytes
  chunksServed: number;
  chunksDownloaded: number;
  postsReplicated: number;
  mediaReplicated: number;
  uptime: number; // Seconds
  successfulUploads: number;
  successfulDownloads: number;
  requestsReceived: number;
  lastUpdated: number;
}

/**
 * Contribution score
 */
export interface ContributionScore {
  peerId: PeerId;
  totalScore: number;
  storageScore: number;
  bandwidthScore: number;
  replicationScore: number;
  uptimeScore: number;
  reliabilityScore: number;
  lastUpdated: number;
}

/**
 * Trust score
 */
export interface TrustScore {
  peerId: PeerId;
  score: number; // 0-1000
  availability: number; // 0-100%
  latency: number; // ms
  successfulResponses: number;
  failedResponses: number;
  lastUpdated: number;
}

/**
 * Contribution ledger entry
 */
export interface LedgerEntry {
  id: string;
  peerId: PeerId;
  eventType: ContributionEventType;
  timestamp: number;
  value: number;
  description: string;
  metadata?: Record<string, unknown>;
}

/**
 * Fraud detection result
 */
export interface FraudDetectionResult {
  isFraud: boolean;
  fraudType:
    | 'SYBIL'
    | 'DATA_CORRUPTION'
    | 'FAKE_STORAGE'
    | 'FAKE_PING'
    | 'DUPLICATE_CHUNKS'
    | 'MANIPULATION'
    | null;
  confidence: number; // 0-100%
  evidence: string[];
  timestamp: number;
}

/**
 * Contribution statistics
 */
export interface ContributionStatistics {
  totalPeers: number;
  totalStorageShared: number;
  totalBandwidthShared: number;
  totalChunksServed: number;
  averageUptime: number;
  averageTrustScore: number;
  topContributors: PeerId[];
  lastUpdated: number;
}

/**
 * Contribution weight configuration
 */
export interface ContributionWeights {
  storageWeight: number;
  bandwidthWeight: number;
  replicationWeight: number;
  uptimeWeight: number;
  reliabilityWeight: number;
}

/**
 * Default contribution weights
 */
export const defaultContributionWeights: ContributionWeights = {
  storageWeight: 0.3,
  bandwidthWeight: 0.25,
  replicationWeight: 0.2,
  uptimeWeight: 0.15,
  reliabilityWeight: 0.1,
};

/**
 * Trust score thresholds
 */
export interface TrustThresholds {
  excellent: number;
  good: number;
  acceptable: number;
  poor: number;
  bad: number;
}

/**
 * Default trust score thresholds
 */
export const defaultTrustThresholds: TrustThresholds = {
  excellent: 800,
  good: 600,
  acceptable: 400,
  poor: 200,
  bad: 0,
};
