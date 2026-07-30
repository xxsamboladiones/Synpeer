/**
 * Network types for Synpeer P2P layer
 */

/**
 * Peer identifier (libp2p peer ID)
 */
export type PeerId = string;

/**
 * Multiaddr for network addresses
 */
export type Multiaddr = string;

/**
 * Network configuration
 */
export interface NetworkConfig {
  /** Bootstrap peer addresses */
  bootstrapPeers: Multiaddr[];
  /** Enable local discovery */
  enableLocalDiscovery: boolean;
  /** Connection timeout in milliseconds */
  connectionTimeout: number;
  /** Maximum number of connections */
  maxConnections: number;
  /** Enable debug logging */
  debug: boolean;
}

/**
 * Peer information
 */
export interface PeerInfo {
  id: PeerId;
  addresses: Multiaddr[];
  connected: boolean;
  latency?: number;
  lastSeen?: number;
}

/**
 * Connection state
 */
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

/**
 * Network statistics
 */
export interface NetworkStats {
  connectedPeers: number;
  totalPeers: number;
  messagesSent: number;
  messagesReceived: number;
  uptime: number;
  reconnectCount: number;
}
