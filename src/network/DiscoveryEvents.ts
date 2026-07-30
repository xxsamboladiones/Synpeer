import type { PeerId } from './NetworkTypes';

/**
 * Discovery events for peer discovery
 */
export type DiscoveryEventType =
  | 'peer:discovered'
  | 'peer:removed'
  | 'discovery:started'
  | 'discovery:stopped'
  | 'discovery:error';

/**
 * Base discovery event
 */
export interface DiscoveryEvent {
  type: DiscoveryEventType;
  timestamp: number;
}

/**
 * Peer discovered event
 */
export interface PeerDiscoveredEvent extends DiscoveryEvent {
  type: 'peer:discovered';
  peerId: PeerId;
  source: 'bootstrap' | 'local' | 'manual';
}

/**
 * Peer removed event
 */
export interface PeerRemovedEvent extends DiscoveryEvent {
  type: 'peer:removed';
  peerId: PeerId;
  reason: 'timeout' | 'disconnect' | 'manual';
}

/**
 * Discovery started event
 */
export interface DiscoveryStartedEvent extends DiscoveryEvent {
  type: 'discovery:started';
}

/**
 * Discovery stopped event
 */
export interface DiscoveryStoppedEvent extends DiscoveryEvent {
  type: 'discovery:stopped';
}

/**
 * Discovery error event
 */
export interface DiscoveryErrorEvent extends DiscoveryEvent {
  type: 'discovery:error';
  error: string;
}

/**
 * Union type for all discovery events
 */
export type AllDiscoveryEvents =
  | PeerDiscoveredEvent
  | PeerRemovedEvent
  | DiscoveryStartedEvent
  | DiscoveryStoppedEvent
  | DiscoveryErrorEvent;

/**
 * Event listener for discovery events
 */
export type DiscoveryEventListener = (event: AllDiscoveryEvents) => void;
