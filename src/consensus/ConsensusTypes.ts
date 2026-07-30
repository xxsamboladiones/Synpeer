import type { PeerId } from '../network/NetworkTypes';

/**
 * Contribution types
 */
export type ContributionType = 'STORAGE' | 'BANDWIDTH' | 'VALIDATION' | 'WITNESS';

/**
 * Vote types
 */
export type VoteType = 'approve' | 'reject' | 'abstain';

/**
 * Consensus status
 */
export type ConsensusStatus = 'pending' | 'voting' | 'reached' | 'failed' | 'expired';

/**
 * Signature structure
 */
export interface Signature {
  algorithm: 'ed25519';
  publicKey: string;
  signature: string;
  timestamp: number;
}

/**
 * Contribution evidence
 */
export interface ContributionEvidence {
  contributionId: string;
  contributor: PeerId;
  type: ContributionType;
  value: number;
  timestamp: number;
  chunkId?: string;
  recipient?: PeerId;
  witnesses: PeerId[];
  signatures: Signature[];
  hash: string;
}

/**
 * Contribution vote
 */
export interface ContributionVote {
  contributionId: string;
  voter: PeerId;
  vote: VoteType;
  reason?: string;
  timestamp: number;
  signature: string;
}

/**
 * Contribution proof
 */
export interface ContributionProof {
  contributionId: string;
  contributor: PeerId;
  type: ContributionType;
  value: number;
  timestamp: number;
  evidence: ContributionEvidence;
  votes: ContributionVote[];
  quorumReached: boolean;
  approvalPercentage: number;
  hash: string;
  signature: string;
}

/**
 * Proof bundle
 */
export interface ProofBundle {
  version: string;
  bundleId: string;
  creator: PeerId;
  timestamp: number;
  contributions: ContributionProof[];
  totalValue: number;
  trustScore: number;
  hash: string;
  signature: string;
}

/**
 * Consensus round
 */
export interface ConsensusRound {
  roundId: string;
  contributionId: string;
  status: ConsensusStatus;
  startTime: number;
  endTime?: number;
  witnesses: PeerId[];
  votes: ContributionVote[];
  quorumRequired: number;
  quorumReached: boolean;
  approvalPercentage: number;
  result?: 'approved' | 'rejected';
}

/**
 * Witness selection criteria
 */
export interface WitnessSelectionCriteria {
  minTrustScore: number;
  minCount: number;
  maxCount: number;
  requireGeographicDiversity: boolean;
  requireRandomSelection: boolean;
}

/**
 * Quorum requirements
 */
export interface QuorumRequirements {
  minPeers: number;
  requiredAgreement: number; // 0-1
  minTrustScore: number;
  timeout: number; // milliseconds
}

/**
 * Default quorum requirements
 */
export const defaultQuorumRequirements: QuorumRequirements = {
  minPeers: 3,
  requiredAgreement: 0.66, // 66%
  minTrustScore: 600,
  timeout: 300000, // 5 minutes
};

/**
 * Contribution claim
 */
export interface ContributionClaim {
  claimId: string;
  claimer: PeerId;
  type: ContributionType;
  value: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
  signature: string;
}

/**
 * Fraud report
 */
export interface FraudReport {
  reportId: string;
  reporter: PeerId;
  accused: PeerId;
  fraudType:
    | 'SYBIL'
    | 'DATA_CORRUPTION'
    | 'FAKE_STORAGE'
    | 'FAKE_PING'
    | 'DUPLICATE_CHUNKS'
    | 'MANIPULATION';
  evidence: string[];
  timestamp: number;
  signature: string;
}

/**
 * Distributed trust score
 */
export interface DistributedTrustScore {
  peerId: PeerId;
  localScore: number;
  networkScore: number;
  aggregatedScore: number;
  reporterCount: number;
  lastUpdated: number;
  signatures: Signature[];
}

/**
 * Consensus configuration
 */
export interface ConsensusConfig {
  protocolVersion: string;
  maxPacketSize: number;
  chunkSize: number;
  signatureValidity: number;
  nonceValidity: number;
  quorumThreshold: number;
  minTrustScore: number;
  maxBundleSize: number;
  maxContributionsPerBundle: number;
}

/**
 * Default consensus configuration
 */
export const defaultConsensusConfig: ConsensusConfig = {
  protocolVersion: '1.0.0',
  maxPacketSize: 10 * 1024 * 1024, // 10MB
  chunkSize: 1 * 1024 * 1024, // 1MB
  signatureValidity: 5 * 60 * 1000, // 5 minutes
  nonceValidity: 5 * 60 * 1000, // 5 minutes
  quorumThreshold: 0.66, // 66%
  minTrustScore: 600,
  maxBundleSize: 5 * 1024 * 1024, // 5MB
  maxContributionsPerBundle: 100,
};

/**
 * Peer fingerprint for anti-sybil
 */
export interface PeerFingerprint {
  peerId: PeerId;
  ipAddress?: string;
  userAgent?: string;
  behaviorPattern: string;
  creationTime: number;
  firstSeen: number;
  lastSeen: number;
  connectionCount: number;
}

/**
 * Consensus statistics
 */
export interface ConsensusStatistics {
  totalRounds: number;
  successfulRounds: number;
  failedRounds: number;
  averageRoundTime: number;
  totalContributions: number;
  totalProofs: number;
  totalBundles: number;
  averageApprovalRate: number;
  fraudReports: number;
  sybilDetections: number;
  lastUpdated: number;
}
