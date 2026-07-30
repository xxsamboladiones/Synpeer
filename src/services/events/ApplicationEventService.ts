import type { NetworkEvent, NetworkEvents, PeerOperationalState } from '@/network/NetworkEvents';
import type { PeerId } from '@/network/NetworkTypes';
import type { SynpeerPrivateNetworkSnapshot } from '@/network/WebRtcAutoSignaling';
import { createLogger } from '@/observability/Logger';
import type { SocialEvent, SocialEventBus } from '@/services/social/SocialEventBus';

export type ApplicationEventTopic =
  'feed' | 'chat' | 'notifications' | 'profile' | 'peers' | 'discover';

export type ApplicationDataEntity = 'post' | 'profile' | 'comment' | 'reaction' | 'follow' | 'chat';

interface ApplicationEventBase {
  topics: readonly ApplicationEventTopic[];
  timestamp: number;
}

export type ApplicationEvent =
  | (ApplicationEventBase & {
      type: 'application.data.changed';
      entity: ApplicationDataEntity;
      entityId?: string;
      source: 'local' | 'remote' | 'sync';
      peerId?: PeerId;
    })
  | (ApplicationEventBase & {
      type: 'application.delivery.changed';
      entity: 'post' | 'chat';
      entityId: string;
      state: 'replicated' | 'delivered' | 'read';
      successfulPeers?: number;
      failedPeers?: number;
      peerId?: PeerId;
    })
  | (ApplicationEventBase & {
      type: 'application.peer.state.changed';
      peerId: PeerId;
      state: PeerOperationalState;
      previousState?: PeerOperationalState;
      failureCode?: string;
      retryable: boolean;
    })
  | (ApplicationEventBase & {
      type: 'application.sync.state.changed';
      peerId: PeerId;
      state: 'started' | 'completed' | 'failed';
      itemsSynced?: number;
      errorCode?: string;
      retryable: boolean;
    })
  | (ApplicationEventBase & {
      type: 'application.private-network.changed';
      networkId?: string;
      memberCount: number;
    });

export interface ApplicationConnectivitySnapshot {
  status: PeerOperationalState;
  connectedPeers: number;
  syncingPeers: number;
  reconnectingPeers: number;
  lastSyncAt?: number;
  lastSyncItems?: number;
  lastError?: {
    peerId?: PeerId;
    errorCode: string;
    retryable: boolean;
    occurredAt: number;
  };
}

export interface ApplicationEventSources {
  socialEvents?: Pick<SocialEventBus, 'subscribe'>;
  networkEvents?: Pick<NetworkEvents, 'addAllEventListener' | 'removeAllEventListener'>;
  subscribePrivateNetwork?: (
    handler: (snapshot: SynpeerPrivateNetworkSnapshot | null) => void | Promise<void>,
  ) => () => void;
}

export type ApplicationEventHandler = (event: ApplicationEvent) => void | Promise<void>;

interface Subscription {
  topics: ReadonlySet<ApplicationEventTopic>;
  handler: ApplicationEventHandler;
}

export class ApplicationEventService {
  private readonly logger = createLogger('application.events');
  private readonly subscriptions = new Set<Subscription>();
  private readonly peerStates = new Map<PeerId, PeerOperationalState>();
  private unsubscribeSources: (() => void) | null = null;
  private lastSyncAt?: number;
  private lastSyncItems?: number;
  private lastError?: ApplicationConnectivitySnapshot['lastError'];

  bind(sources: ApplicationEventSources): void {
    this.unsubscribeSources?.();

    const unsubscribes: Array<() => void> = [];
    if (sources.socialEvents) {
      unsubscribes.push(
        sources.socialEvents.subscribe((event) => {
          this.handleSocialEvent(event);
        }),
      );
    }
    if (sources.networkEvents) {
      const listener = (event: NetworkEvent) => {
        this.handleNetworkEvent(event);
      };
      sources.networkEvents.addAllEventListener(listener);
      unsubscribes.push(() => {
        sources.networkEvents?.removeAllEventListener(listener);
      });
    }
    if (sources.subscribePrivateNetwork) {
      unsubscribes.push(
        sources.subscribePrivateNetwork((snapshot) => {
          this.emit({
            type: 'application.private-network.changed',
            topics: ['peers'],
            timestamp: Date.now(),
            networkId: snapshot?.networkId,
            memberCount: snapshot?.members.length ?? 0,
          });
        }),
      );
    }

    this.unsubscribeSources = () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }

  stop(): void {
    this.unsubscribeSources?.();
    this.unsubscribeSources = null;
    this.peerStates.clear();
    this.lastSyncAt = undefined;
    this.lastSyncItems = undefined;
    this.lastError = undefined;
  }

  subscribe(
    topics: ApplicationEventTopic | readonly ApplicationEventTopic[],
    handler: ApplicationEventHandler,
  ): () => void {
    const subscription: Subscription = {
      topics: new Set(Array.isArray(topics) ? topics : [topics]),
      handler,
    };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  getConnectivitySnapshot(): ApplicationConnectivitySnapshot {
    const states = Array.from(this.peerStates.values());
    const connectedPeers = states.filter(isConnectedState).length;
    const syncingPeers = states.filter((state) => state === 'syncing').length;
    const reconnectingPeers = states.filter((state) => state === 'reconnecting').length;

    return {
      status: getAggregateStatus(states),
      connectedPeers,
      syncingPeers,
      reconnectingPeers,
      lastSyncAt: this.lastSyncAt,
      lastSyncItems: this.lastSyncItems,
      lastError: this.lastError ? { ...this.lastError } : undefined,
    };
  }

  private handleSocialEvent(event: SocialEvent): void {
    if (event.type === 'social.post.replication.completed') {
      this.emit({
        type: 'application.delivery.changed',
        topics: ['feed'],
        timestamp: event.timestamp,
        entity: 'post',
        entityId: event.postId,
        state: 'replicated',
        successfulPeers: event.successfulPeers.length,
        failedPeers: event.failedPeers.length,
      });
      return;
    }
    if (
      event.type === 'social.chat.delivery.updated' ||
      event.type === 'social.chat.read.updated'
    ) {
      this.emit({
        type: 'application.delivery.changed',
        topics: ['chat', 'notifications'],
        timestamp: event.timestamp,
        entity: 'chat',
        entityId: event.messageId,
        state: event.type === 'social.chat.read.updated' ? 'read' : 'delivered',
        peerId: event.peerId,
      });
      return;
    }
    if (event.type === 'social.sync.completed') {
      this.lastSyncAt = event.timestamp;
      this.lastSyncItems = event.received;
      this.emit({
        type: 'application.sync.state.changed',
        topics: ALL_DATA_TOPICS,
        timestamp: event.timestamp,
        peerId: event.peerId,
        state: 'completed',
        itemsSynced: event.received,
        retryable: false,
      });
      return;
    }
    if (event.type === 'social.sync.failed') {
      this.lastError = {
        peerId: event.peerId,
        errorCode: event.errorCode,
        retryable: true,
        occurredAt: event.timestamp,
      };
      this.emit({
        type: 'application.sync.state.changed',
        topics: ['peers'],
        timestamp: event.timestamp,
        peerId: event.peerId,
        state: 'failed',
        errorCode: event.errorCode,
        retryable: true,
      });
      return;
    }
    if (event.type === 'social.conflict.detected') {
      this.emit({
        type: 'application.data.changed',
        topics: getEntityTopics(event.entity),
        timestamp: event.timestamp,
        entity: event.entity,
        entityId: event.entityId,
        source: 'remote',
        peerId: event.peerId,
      });
      return;
    }

    const entity = getSocialEntity(event);
    if (!entity) {
      return;
    }
    this.emit({
      type: 'application.data.changed',
      topics: getEntityTopics(entity),
      timestamp: event.timestamp,
      entity,
      entityId: getSocialEntityId(event),
      source: getSocialEventSource(event),
      peerId: 'peerId' in event ? event.peerId : undefined,
    });
  }

  private handleNetworkEvent(event: NetworkEvent): void {
    if (event.type === 'peer:state-changed') {
      this.peerStates.set(event.peerId, event.state);
      if (event.failureCode) {
        this.lastError = {
          peerId: event.peerId,
          errorCode: event.failureCode,
          retryable: event.state === 'reconnecting' || event.state === 'degraded',
          occurredAt: event.timestamp,
        };
      } else if (event.state === 'online' && this.lastError?.peerId === event.peerId) {
        this.lastError = undefined;
      }
      this.emit({
        type: 'application.peer.state.changed',
        topics: ['peers'],
        timestamp: event.timestamp,
        peerId: event.peerId,
        state: event.state,
        previousState: event.previousState,
        failureCode: event.failureCode,
        retryable: event.state === 'reconnecting' || event.state === 'degraded',
      });
      return;
    }
    if (event.type === 'peer:connected' || event.type === 'peer:disconnected') {
      const state = event.type === 'peer:connected' ? 'online' : 'offline';
      const previousState = this.peerStates.get(event.peerId);
      this.peerStates.set(event.peerId, state);
      if (state === 'online' && this.lastError?.peerId === event.peerId) {
        this.lastError = undefined;
      }
      this.emit({
        type: 'application.peer.state.changed',
        topics: ['peers'],
        timestamp: event.timestamp,
        peerId: event.peerId,
        state,
        previousState,
        failureCode: event.type === 'peer:disconnected' ? event.reason : undefined,
        retryable: event.type === 'peer:disconnected',
      });
      return;
    }
    if (event.type === 'sync:started' || event.type === 'sync:finished') {
      const successful = event.type === 'sync:started' || event.success;
      const state = event.type === 'sync:started' ? 'started' : successful ? 'completed' : 'failed';
      this.peerStates.set(
        event.peerId,
        state === 'started' ? 'syncing' : successful ? 'online' : 'degraded',
      );
      if (event.type === 'sync:finished' && event.success) {
        this.lastSyncAt = event.timestamp;
        this.lastSyncItems = event.itemsSynced ?? 0;
        if (this.lastError?.peerId === event.peerId) {
          this.lastError = undefined;
        }
      }
      if (!successful) {
        this.lastError = {
          peerId: event.peerId,
          errorCode: 'PEER_INCREMENTAL_SYNC_FAILED',
          retryable: true,
          occurredAt: event.timestamp,
        };
      }
      this.emit({
        type: 'application.sync.state.changed',
        topics: state === 'completed' ? ALL_DATA_TOPICS : ['peers'],
        timestamp: event.timestamp,
        peerId: event.peerId,
        state,
        itemsSynced: event.type === 'sync:finished' ? event.itemsSynced : undefined,
        errorCode: state === 'failed' ? 'PEER_INCREMENTAL_SYNC_FAILED' : undefined,
        retryable: state === 'failed',
      });
      return;
    }
    if (event.type === 'network:error') {
      this.lastError = {
        peerId: event.peerId,
        errorCode: 'NETWORK_ERROR',
        retryable: true,
        occurredAt: event.timestamp,
      };
    }
  }

  private emit(event: ApplicationEvent): void {
    for (const subscription of this.subscriptions) {
      if (!event.topics.some((topic) => subscription.topics.has(topic))) {
        continue;
      }
      Promise.resolve(subscription.handler(event)).catch((error: unknown) => {
        this.logger.error('subscriber_failed', error, {
          eventType: event.type,
        });
      });
    }
  }
}

const ALL_DATA_TOPICS: readonly ApplicationEventTopic[] = [
  'feed',
  'chat',
  'notifications',
  'profile',
  'peers',
  'discover',
];

function getSocialEntity(event: SocialEvent): ApplicationDataEntity | null {
  if (event.type.startsWith('social.post.')) {
    return 'post';
  }
  if (event.type === 'social.profile.updated') {
    return 'profile';
  }
  if (event.type === 'social.comment.persisted') {
    return 'comment';
  }
  if (event.type === 'social.reaction.persisted') {
    return 'reaction';
  }
  if (event.type === 'social.follow.persisted') {
    return 'follow';
  }
  if (event.type === 'social.chat.persisted') {
    return 'chat';
  }
  return null;
}

function getSocialEntityId(event: SocialEvent): string | undefined {
  switch (event.type) {
    case 'social.post.created':
    case 'social.post.received':
    case 'social.post.persisted':
    case 'social.post.updated':
    case 'social.post.deleted':
      return event.postId;
    case 'social.profile.updated':
      return event.profileId;
    case 'social.comment.persisted':
      return event.commentId;
    case 'social.reaction.persisted':
      return event.reactionId;
    case 'social.follow.persisted':
      return event.followId;
    case 'social.chat.persisted':
    case 'social.chat.delivery.updated':
    case 'social.chat.read.updated':
      return event.messageId;
    case 'social.post.replication.completed':
    case 'social.sync.completed':
    case 'social.sync.failed':
    case 'social.conflict.detected':
      return undefined;
  }
}

function getSocialEventSource(event: SocialEvent): 'local' | 'remote' | 'sync' {
  if ('origin' in event) {
    return event.origin;
  }
  return event.type === 'social.post.received' ? 'remote' : 'local';
}

function getEntityTopics(entity: ApplicationDataEntity): readonly ApplicationEventTopic[] {
  switch (entity) {
    case 'post':
      return ['feed', 'notifications', 'profile', 'discover'];
    case 'profile':
      return ['feed', 'notifications', 'profile', 'discover'];
    case 'comment':
    case 'reaction':
      return ['feed', 'notifications'];
    case 'follow':
      return ['chat', 'notifications', 'profile', 'discover'];
    case 'chat':
      return ['chat', 'notifications'];
  }
}

function isConnectedState(state: PeerOperationalState): boolean {
  return (
    state === 'handshaking' || state === 'syncing' || state === 'online' || state === 'degraded'
  );
}

function getAggregateStatus(states: readonly PeerOperationalState[]): PeerOperationalState {
  if (states.includes('syncing')) {
    return 'syncing';
  }
  if (states.includes('online')) {
    return 'online';
  }
  if (states.includes('handshaking')) {
    return 'handshaking';
  }
  if (states.includes('connecting')) {
    return 'connecting';
  }
  if (states.includes('reconnecting')) {
    return 'reconnecting';
  }
  if (states.includes('degraded')) {
    return 'degraded';
  }
  return 'offline';
}
