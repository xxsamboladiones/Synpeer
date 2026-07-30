import type { NetworkConfig } from './NetworkTypes';

/**
 * Default network configuration for Synpeer
 */
export const defaultNetworkConfig: NetworkConfig = {
  bootstrapPeers: [
    // Add bootstrap peers here for production
    // For development, we'll use local discovery
  ],
  enableLocalDiscovery: true,
  connectionTimeout: 30000, // 30 seconds
  maxConnections: 50,
  debug: __DEV__,
};

/**
 * Development network configuration
 */
export const devNetworkConfig: NetworkConfig = {
  ...defaultNetworkConfig,
  debug: true,
  maxConnections: 10, // Lower limit for development
};
