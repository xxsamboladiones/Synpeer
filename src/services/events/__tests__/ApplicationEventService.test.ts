import { NetworkEvents } from '@/network/NetworkEvents';
import type { SynpeerPrivateNetworkSnapshot } from '@/network/WebRtcAutoSignaling';
import { SocialEventBus } from '@/services/social/SocialEventBus';

import { ApplicationEventService, type ApplicationEvent } from '../ApplicationEventService';

describe('ApplicationEventService', () => {
  it('routes social changes only to interested application topics', () => {
    const socialEvents = new SocialEventBus();
    const service = new ApplicationEventService();
    const feedEvents: ApplicationEvent[] = [];
    const peerEvents: ApplicationEvent[] = [];
    service.bind({ socialEvents });
    service.subscribe('feed', (event) => {
      feedEvents.push(event);
    });
    service.subscribe('peers', (event) => {
      peerEvents.push(event);
    });

    socialEvents.emit({
      type: 'social.comment.persisted',
      commentId: 'comment-1',
      postId: 'post-1',
      origin: 'remote',
      peerId: 'peer-a',
      timestamp: 10,
    });

    expect(feedEvents).toEqual([
      expect.objectContaining({
        type: 'application.data.changed',
        entity: 'comment',
        entityId: 'comment-1',
        source: 'remote',
        peerId: 'peer-a',
      }),
    ]);
    expect(peerEvents).toEqual([]);
  });

  it('derives connectivity and sync state from real network events', () => {
    const networkEvents = new NetworkEvents();
    const service = new ApplicationEventService();
    const received: ApplicationEvent[] = [];
    service.bind({ networkEvents });
    service.subscribe('peers', (event) => {
      received.push(event);
    });

    networkEvents.emit({
      category: 'peer',
      type: 'peer:state-changed',
      peerId: 'peer-a',
      state: 'connecting',
      reconnectAttempts: 0,
      timestamp: 10,
    });
    expect(service.getConnectivitySnapshot()).toEqual(
      expect.objectContaining({
        status: 'connecting',
        connectedPeers: 0,
      }),
    );

    networkEvents.emit({
      category: 'sync',
      type: 'sync:started',
      peerId: 'peer-a',
      syncType: 'data',
      timestamp: 20,
    });
    expect(service.getConnectivitySnapshot()).toEqual(
      expect.objectContaining({
        status: 'syncing',
        connectedPeers: 1,
        syncingPeers: 1,
      }),
    );

    networkEvents.emit({
      category: 'sync',
      type: 'sync:finished',
      peerId: 'peer-a',
      syncType: 'data',
      success: true,
      itemsSynced: 4,
      timestamp: 30,
    });
    expect(service.getConnectivitySnapshot()).toEqual({
      status: 'online',
      connectedPeers: 1,
      syncingPeers: 0,
      reconnectingPeers: 0,
      lastSyncAt: 30,
      lastSyncItems: 4,
      lastError: undefined,
    });
    expect(received).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'application.sync.state.changed',
          state: 'completed',
          itemsSynced: 4,
          retryable: false,
        }),
      ]),
    );
  });

  it('marks failed sync as retryable without inventing a successful state', () => {
    const networkEvents = new NetworkEvents();
    const service = new ApplicationEventService();
    service.bind({ networkEvents });

    networkEvents.emit({
      category: 'sync',
      type: 'sync:finished',
      peerId: 'peer-a',
      syncType: 'data',
      success: false,
      timestamp: 40,
    });

    expect(service.getConnectivitySnapshot()).toEqual(
      expect.objectContaining({
        status: 'degraded',
        connectedPeers: 1,
        lastError: {
          peerId: 'peer-a',
          errorCode: 'PEER_INCREMENTAL_SYNC_FAILED',
          retryable: true,
          occurredAt: 40,
        },
      }),
    );

    networkEvents.emit({
      category: 'sync',
      type: 'sync:finished',
      peerId: 'peer-a',
      syncType: 'data',
      success: true,
      itemsSynced: 0,
      timestamp: 50,
    });
    expect(service.getConnectivitySnapshot()).toEqual(
      expect.objectContaining({
        status: 'online',
        lastError: undefined,
      }),
    );
  });

  it('rebinds sources without duplicating listeners and stops cleanly', () => {
    const firstSocialEvents = new SocialEventBus();
    const secondSocialEvents = new SocialEventBus();
    const service = new ApplicationEventService();
    const handler = jest.fn();
    service.subscribe('profile', handler);

    service.bind({ socialEvents: firstSocialEvents });
    firstSocialEvents.emit(profileUpdatedEvent(10));
    expect(handler).toHaveBeenCalledTimes(1);

    service.bind({ socialEvents: secondSocialEvents });
    firstSocialEvents.emit(profileUpdatedEvent(20));
    secondSocialEvents.emit(profileUpdatedEvent(30));
    expect(handler).toHaveBeenCalledTimes(2);

    service.stop();
    secondSocialEvents.emit(profileUpdatedEvent(40));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('publishes private network membership changes to the peer topic', () => {
    let privateNetworkHandler = (
      snapshot: SynpeerPrivateNetworkSnapshot | null,
    ): void | Promise<void> => {
      void snapshot;
    };
    const service = new ApplicationEventService();
    const handler = jest.fn();
    service.subscribe('peers', handler);
    service.bind({
      subscribePrivateNetwork: (nextHandler) => {
        privateNetworkHandler = nextHandler;
        return () => {
          privateNetworkHandler = () => undefined;
        };
      },
    });

    void privateNetworkHandler(null);

    expect(handler).toHaveBeenCalledWith({
      type: 'application.private-network.changed',
      topics: ['peers'],
      timestamp: expect.any(Number),
      networkId: undefined,
      memberCount: 0,
    });
  });

  it('removes application subscribers through the returned cleanup function', () => {
    const socialEvents = new SocialEventBus();
    const service = new ApplicationEventService();
    const handler = jest.fn();
    service.bind({ socialEvents });
    const unsubscribe = service.subscribe('profile', handler);

    socialEvents.emit(profileUpdatedEvent(10));
    unsubscribe();
    socialEvents.emit(profileUpdatedEvent(20));

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

function profileUpdatedEvent(timestamp: number) {
  return {
    type: 'social.profile.updated' as const,
    profileId: 'profile-a',
    author: 'peer-a',
    origin: 'remote' as const,
    timestamp,
  };
}
