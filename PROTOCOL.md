# Synpeer Protocol Specification

**Version:** 2.0.0
**Date:** 2026-07-08
**Status:** Draft

## Table of Contents

1. [Overview](#overview)
2. [Protocol Versioning](#protocol-versioning)
3. [Network Packet Structure](#network-packet-structure)
4. [Signature Format](#signature-format)
5. [Consensus Rules](#consensus-rules)
6. [Trust Score Algorithm](#trust-score-algorithm)
7. [Proof of Contribution Algorithm](#proof-of-contribution-algorithm)
8. [Proof Bundle Format](#proof-bundle-format)
9. [Economy Layer](#economy-layer)
10. [Version Compatibility](#version-compatibility)
11. [Security Considerations](#security-considerations)

## Overview

The Synpeer protocol is a peer-to-peer distributed social network protocol that enables:

- Decentralized content sharing (posts, media, comments)
- Distributed consensus on contributions
- Trust-based peer reputation
- Anti-Sybil mechanisms
- Proof of Contribution without blockchain

This specification defines the network protocol that any Synpeer client must implement to participate in the network.

## Protocol Versioning

### Version Format

Protocol versions follow semantic versioning: `MAJOR.MINOR.PATCH`

- **MAJOR:** Breaking changes in packet structure or consensus rules
- **MINOR:** New features, backward-compatible changes
- **PATCH:** Bug fixes, optimizations

### Current Version

**2.0.0** - Economy Layer addition

- Added reward-related packet types
- Added economy layer specification
- Added wallet and transaction types
- Added ledger and snapshot structures
- Added anti-abuse mechanisms

### Version Negotiation

Peers negotiate protocol version during initial handshake:

```typescript
interface HandshakePacket {
  type: 'HANDSHAKE';
  protocolVersion: string;
  supportedVersions: string[];
  peerId: string;
  timestamp: number;
  signature: string;
}
```

Peers use the highest mutually supported version.

## Network Packet Structure

### Base Packet

All network packets extend the base structure:

```typescript
interface BasePacket {
  type: PacketType;
  version: string;
  peerId: string;
  timestamp: number;
  signature: string;
  nonce: string;
}

type PacketType =
  | 'HANDSHAKE'
  | 'POST'
  | 'COMMENT'
  | 'MEDIA'
  | 'CHUNK'
  | 'CONTRIBUTION'
  | 'VOTE'
  | 'EVIDENCE'
  | 'WITNESS'
  | 'CONSENSUS'
  | 'TRUST'
  | 'PROOF_BUNDLE'
  | 'REWARD_CLAIM'
  | 'REWARD_DISTRIBUTION'
  | 'WALLET_SYNC'
  | 'TRANSACTION'
  | 'LEDGER_SNAPSHOT'
  | 'ABUSE_REPORT';
```

### Packet Serialization

Packets are serialized as JSON with the following format:

```
{
  "type": "POST",
  "version": "1.0.0",
  "peerId": "QmXxx...",
  "timestamp": 1688765432000,
  "nonce": "random-string",
  "payload": { ... },
  "signature": "base64-signature"
}
```

### Packet Size Limits

- Maximum packet size: 10MB
- Chunk packets: 1MB per chunk
- Media metadata: 100KB
- Text content: 64KB

## Signature Format

### Signature Algorithm

All signatures use Ed25519 (EdDSA) for cryptographic signing.

### Signature Structure

```typescript
interface Signature {
  algorithm: 'ed25519';
  publicKey: string; // Base64 encoded
  signature: string; // Base64 encoded
  timestamp: number;
}
```

### Signing Process

1. Serialize packet payload (excluding signature field)
2. Create canonical JSON (sorted keys, no whitespace)
3. Hash using SHA-256
4. Sign hash with Ed25519 private key
5. Include signature in packet

### Verification Process

1. Extract signature and public key from packet
2. Serialize payload (excluding signature field)
3. Create canonical JSON
4. Hash using SHA-256
5. Verify signature using Ed25519 public key

### Signature Validation

Signatures are invalid if:

- Timestamp is older than 5 minutes
- Nonce is reused
- Signature verification fails
- Public key is not in peer's identity

## Consensus Rules

### Consensus Types

The protocol supports multiple consensus mechanisms:

1. **Contribution Consensus** - Validate peer contributions
2. **Trust Consensus** - Aggregate peer trust scores
3. **Fraud Consensus** - Detect malicious behavior

### Contribution Consensus

A contribution is validated when:

1. Evidence is collected from at least 3 witnesses
2. Witnesses have trust score ≥ 600
3. Votes reach quorum (66% agreement)
4. No fraud flags are raised

### Trust Consensus

Trust scores are aggregated when:

1. At least 5 peers report trust score for a peer
2. Reporting peers have trust score ≥ 700
3. Outliers (>2 standard deviations) are excluded
4. Weighted average is calculated

### Fraud Consensus

Fraud is confirmed when:

1. At least 3 independent peers report fraud
2. Evidence is provided (hashes, timestamps)
3. Quorum (75% agreement) is reached
4. Peer is penalized (trust score -200)

### Quorum Requirements

| Operation           | Minimum Peers | Required Agreement | Minimum Trust |
| ------------------- | ------------- | ------------------ | ------------- |
| Contribution        | 3             | 66%                | 600           |
| Trust Update        | 5             | 60%                | 700           |
| Fraud Detection     | 3             | 75%                | 800           |
| Evidence Validation | 2             | 100%               | 500           |

## Trust Score Algorithm

### Base Trust Score

Initial trust score for new peers: **500** (neutral)

### Trust Score Calculation

```
TrustScore = BaseScore + ContributionScore + ReliabilityScore - PenaltyScore
```

#### Contribution Score (0-300)

- Storage shared: 1 point per MB (max 100)
- Bandwidth shared: 1 point per MB (max 100)
- Chunks served: 0.1 point per chunk (max 50)
- Uptime: 0.01 point per minute (max 50)

#### Reliability Score (0-200)

- Success rate: 100% = 100 points
- Availability: 99%+ = 50 points, 90%+ = 30 points
- Response time: <100ms = 50 points, <500ms = 30 points

#### Penalty Score (0-∞)

- Invalid data: -50 per occurrence
- Failed requests: -10 per occurrence
- Fraud detection: -200 per confirmed fraud
- Sybil detection: -500 (permanent ban)

### Trust Score Decay

Trust scores decay over time for inactive peers:

- Decay rate: 1% per day of inactivity
- Minimum score: 0
- Decay starts after 7 days of inactivity

### Trust Score Ranges

| Range    | Level      | Description               |
| -------- | ---------- | ------------------------- |
| 0-199    | Bad        | Untrusted, limited access |
| 200-399  | Poor       | Low trust, restricted     |
| 400-599  | Acceptable | Normal peer access        |
| 600-799  | Good       | Trusted, can witness      |
| 800-1000 | Excellent  | Highly trusted, can vote  |

## Proof of Contribution Algorithm

### Contribution Types

1. **Storage Contribution** - Storing chunks for other peers
2. **Bandwidth Contribution** - Serving chunks to other peers
3. **Validation Contribution** - Validating content integrity
4. **Witness Contribution** - Witnessing peer contributions

### Evidence Collection

For each contribution, evidence is collected:

```typescript
interface ContributionEvidence {
  contributionId: string;
  contributor: string;
  type: ContributionType;
  value: number;
  timestamp: number;
  chunkId?: string;
  recipient?: string;
  witnesses: string[];
  signatures: Signature[];
  hash: string;
}
```

### Witness Selection

Witnesses are selected based on:

1. Trust score (≥ 600 required)
2. Geographic diversity
3. Random selection from trusted pool
4. Minimum 3 witnesses per contribution

### Vote Collection

Peers vote on contribution validity:

```typescript
interface ContributionVote {
  contributionId: string;
  voter: string;
  vote: 'approve' | 'reject' | 'abstain';
  reason?: string;
  timestamp: number;
  signature: string;
}
```

### Quorum Calculation

Quorum is reached when:

- Minimum witnesses vote (3)
- 66% approve
- No fraud flags
- Evidence is valid

### Proof Generation

Once quorum is reached, a proof is generated:

```typescript
interface ContributionProof {
  contributionId: string;
  contributor: string;
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
```

## Proof Bundle Format

### Bundle Structure

A proof bundle aggregates multiple contributions:

```typescript
interface ProofBundle {
  version: string;
  bundleId: string;
  creator: string;
  timestamp: number;
  contributions: ContributionProof[];
  totalValue: number;
  trustScore: number;
  hash: string;
  signature: string;
}
```

### Bundle Hash Calculation

Bundle hash is calculated as:

```
bundleHash = SHA256(
  bundleId +
  creator +
  timestamp +
  sorted(contributions.map(c => c.hash)).join('') +
  totalValue +
  trustScore
)
```

### Bundle Validation

A bundle is valid if:

1. All contributions have valid proofs
2. Bundle signature is valid
3. Bundle hash matches calculated hash
4. Timestamp is recent (within 1 hour)
5. Creator trust score ≥ 600

### Bundle Size Limits

- Maximum contributions per bundle: 100
- Maximum bundle size: 5MB
- Maximum time span: 1 hour

## Economy Layer

### Overview

The Economy Layer converts approved Proof Bundles into economic rewards without requiring blockchain infrastructure. It operates on a local ledger with distributed consensus.

### Reward Categories

Rewards are distributed across the following categories:

1. **STORAGE** (30%) - Storing chunks for other peers
2. **BANDWIDTH** (25%) - Serving chunks to other peers
3. **STREAMING** (15%) - Streaming content delivery
4. **REPLICATION** (15%) - Replicating content for redundancy
5. **AVAILABILITY** (10%) - Maintaining high uptime
6. **COMMUNITY** (5%) - Community contributions

### Reward Calculation

Rewards are calculated based on:

```typescript
interface RewardCalculation {
  baseReward: number;
  bonus: number;
  penalty: number;
  netReward: number;
  breakdown: {
    storage: number;
    bandwidth: number;
    streaming: number;
    replication: number;
    availability: number;
    community: number;
  };
}
```

#### Bonus Factors

- High approval rate (≥90%): +10%
- Early contribution (<24h): +5%
- High trust score (≥800): +10%

#### Penalty Factors

- Low approval rate (<66%): -20%
- Low trust score (<500): -15%
- Old contribution (>7 days): -10%

### Emission Schedule

The token emission follows a schedule with annual reductions:

```typescript
interface RewardScheduleEntry {
  year: number;
  dailyEmission: number;
  monthlyEmission: number;
  totalEmission: number;
  reductionRate: number;
}
```

- Year 1: 1,000,000 tokens/day (0% reduction)
- Year 2: 900,000 tokens/day (10% reduction)
- Year 3: 810,000 tokens/day (10% reduction)
- Year 4: 729,000 tokens/day (10% reduction)
- Year 5: 656,100 tokens/day (10% reduction)

### Inflation Control

#### Supply Limits

- Max Supply: 1,000,000,000 INSTA
- Daily Limit: Per schedule entry
- Per-Peer Limit: 1,000 INSTA/day

#### Inflation Rules

- Annual reduction rate: 10%
- Daily emission cap: Enforced per schedule
- Peer emission cap: Prevent farming
- Max supply cap: Hard limit

### Wallet Structure

```typescript
interface Wallet {
  address: string;
  peerId: string;
  balance: number;
  nonce: number;
  version: number;
  createdAt: number;
  updatedAt: number;
}
```

### Transaction Types

```typescript
type TransactionType = 'REWARD' | 'TRANSFER' | 'PENALTY' | 'BONUS' | 'FEE' | 'STAKE' | 'UNSTAKE';

type TransactionStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'CANCELLED';
```

### Ledger Structure

The local ledger records all transactions:

```typescript
interface LedgerEntry {
  id: string;
  walletAddress: string;
  amount: number;
  type: TransactionType;
  category: RewardCategory;
  description: string;
  timestamp: number;
  balance: number;
  metadata?: Record<string, unknown>;
}
```

### Ledger Snapshots

Periodic snapshots ensure ledger integrity:

```typescript
interface LedgerSnapshot {
  id: string;
  timestamp: number;
  totalSupply: number;
  totalWallets: number;
  totalTransactions: number;
  rootHash: string;
  previousSnapshotId: string;
}
```

### Anti-Abuse Mechanisms

#### Abuse Types

- **ARTIFICIAL_FARMING** - Excessive contribution rate
- **AUTO_DOWNLOAD** - Automated download patterns
- **AUTO_LIKE** - Automated like patterns
- **FAKE_STREAMING** - Fake streaming activity
- **PEER_LOOPS** - Circular peer connections
- **RATE_LIMIT_EXCEEDED** - Exceeding rate limits
- **SUSPICIOUS_PATTERN** - Unusual activity patterns

#### Abuse Detection

```typescript
interface AbuseReport {
  id: string;
  peerId: string;
  type: AbuseType;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  timestamp: number;
  description: string;
  evidence?: Record<string, unknown>;
  resolved: boolean;
}
```

#### Penalties

- Low severity: -10 trust score
- Medium severity: -25 trust score
- High severity: -50 trust score
- Critical severity: -100 trust score + temporary ban
- Repeat offenses: Permanent ban

### Reward Claim Process

1. Peer submits contribution proof
2. Proof is validated by consensus
3. Reward is calculated based on category and value
4. Inflation limits are checked
5. Reward is allocated from pool
6. Transaction is recorded in ledger
7. Wallet balance is updated

### Wallet Sync Packet

```typescript
interface WalletSyncPacket {
  type: 'WALLET_SYNC';
  walletAddress: string;
  balance: number;
  nonce: number;
  transactions: Transaction[];
  timestamp: number;
  signature: string;
}
```

### Transaction Packet

```typescript
interface TransactionPacket {
  type: 'TRANSACTION';
  from: string;
  to: string;
  amount: number;
  fee: number;
  nonce: number;
  timestamp: number;
  signature: string;
}
```

### Reward Distribution Packet

```typescript
interface RewardDistributionPacket {
  type: 'REWARD_DISTRIBUTION';
  distributionId: string;
  rewards: Array<{
    walletAddress: string;
    amount: number;
    category: RewardCategory;
  }>;
  timestamp: number;
  signature: string;
}
```

### Abuse Report Packet

```typescript
interface AbuseReportPacket {
  type: 'ABUSE_REPORT';
  reportId: string;
  peerId: string;
  abuseType: AbuseType;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  evidence?: Record<string, unknown>;
  timestamp: number;
  signature: string;
}
```

## Version Compatibility

### Backward Compatibility

Clients MUST support:

- Previous minor version (e.g., 1.0.x supports 0.9.x)
- Packet format conversion
- Graceful degradation for unsupported features

### Forward Compatibility

Clients SHOULD:

- Ignore unknown packet fields
- Handle unknown packet types gracefully
- Log warnings for unsupported features

### Migration Strategy

When MAJOR version changes:

1. Dual-mode operation for 30 days
2. Broadcast version upgrade notifications
3. Gradual peer migration
4. Deprecate old version after migration period

### Feature Flags

New features can be enabled via feature flags:

```typescript
interface FeatureFlags {
  experimentalFeatures: boolean;
  newConsensusAlgorithm: boolean;
  enhancedEncryption: boolean;
  // ...
}
```

## Security Considerations

### Replay Attack Prevention

- All packets include nonce (random string)
- Nonces are tracked for 5 minutes
- Duplicate nonces are rejected

### Sybil Attack Prevention

- Identity verification required
- Trust score threshold for participation
- Behavioral pattern analysis
- IP address tracking (optional)

### DDoS Mitigation

- Rate limiting per peer
- Proof-of-work for expensive operations
- Reputation-based priority
- Circuit breaker pattern

### Privacy Considerations

- Peer IDs are cryptographic hashes
- Content is encrypted in transit
- Metadata is minimized
- Optional anonymous mode

### Key Management

- Ed25519 key pairs for signing
- Key rotation every 90 days
- Secure key storage
- Key revocation mechanism

## Appendix

### A. Packet Type Reference

| Type                | Description            | Size Limit |
| ------------------- | ---------------------- | ---------- |
| HANDSHAKE           | Initial peer handshake | 1KB        |
| POST                | Social post content    | 64KB       |
| COMMENT             | Comment on post        | 32KB       |
| MEDIA               | Media metadata         | 100KB      |
| CHUNK               | Media chunk data       | 1MB        |
| CONTRIBUTION        | Contribution claim     | 8KB        |
| VOTE                | Vote on contribution   | 4KB        |
| EVIDENCE            | Contribution evidence  | 16KB       |
| WITNESS             | Witness signature      | 4KB        |
| CONSENSUS           | Consensus result       | 8KB        |
| TRUST               | Trust score report     | 4KB        |
| PROOF_BUNDLE        | Aggregated proofs      | 5MB        |
| REWARD_CLAIM        | Reward claim packet    | 8KB        |
| REWARD_DISTRIBUTION | Reward distribution    | 32KB       |
| WALLET_SYNC         | Wallet synchronization | 64KB       |
| TRANSACTION         | Transaction packet     | 8KB        |
| LEDGER_SNAPSHOT     | Ledger snapshot        | 128KB      |
| ABUSE_REPORT        | Abuse report           | 16KB       |

### B. Error Codes

| Code | Description            |
| ---- | ---------------------- |
| 1000 | Invalid signature      |
| 1001 | Invalid timestamp      |
| 1002 | Invalid nonce          |
| 1003 | Invalid version        |
| 2000 | Packet too large       |
| 2001 | Invalid packet type    |
| 2002 | Missing required field |
| 3000 | Quorum not reached     |
| 3001 | Evidence invalid       |
| 3002 | Witness not trusted    |
| 4000 | Fraud detected         |
| 4001 | Sybil attack detected  |
| 4002 | Replay attack detected |

### C. Constants

```typescript
const PROTOCOL_VERSION = '2.0.0';
const MAX_PACKET_SIZE = 10 * 1024 * 1024; // 10MB
const CHUNK_SIZE = 1 * 1024 * 1024; // 1MB
const SIGNATURE_VALIDITY = 5 * 60 * 1000; // 5 minutes
const NONCE_VALIDITY = 5 * 60 * 1000; // 5 minutes
const QUORUM_THRESHOLD = 0.66; // 66%
const MIN_TRUST_SCORE = 600;
const MAX_BUNDLE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_CONTRIBUTIONS_PER_BUNDLE = 100;
const MAX_SUPPLY = 1_000_000_000; // 1B INSTA
const DAILY_EMISSION_YEAR_1 = 1_000_000; // 1M tokens/day
const ANNUAL_REDUCTION_RATE = 0.1; // 10%
const PER_PEER_DAILY_LIMIT = 1_000; // 1K INSTA/day
```

---

**Document Version:** 2.0.0
**Last Updated:** 2026-07-08
**Maintainer:** Synpeer Protocol Team
