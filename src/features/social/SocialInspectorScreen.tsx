import React, { useCallback, useState, useEffect } from 'react';

import { Screen } from '@/components/ui';
import { Text } from '@/components/ui/Text';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { appService } from '@/services/AppService';

/**
 * SocialInspectorScreen displays social layer statistics for developers
 */
export function SocialInspectorScreen() {
  const [totalPosts, setTotalPosts] = useState<number>(0);
  const [totalProfiles, setTotalProfiles] = useState<number>(0);
  const [totalComments, setTotalComments] = useState<string>('Indisponivel');
  const [totalReactions, setTotalReactions] = useState<string>('Indisponivel');
  const [totalFollows, setTotalFollows] = useState<string>('Indisponivel');
  const [pendingSyncQueue, setPendingSyncQueue] = useState<number>(0);
  const [knownPeers, setKnownPeers] = useState<number>(0);
  const [replicationStatus, setReplicationStatus] = useState<string>('idle');
  const [databaseStats, setDatabaseStats] = useState<string>('');
  const [lastSync, setLastSync] = useState<string>('Never');

  const refreshStats = useCallback(() => {
    void appService
      .initialize()
      .then(async () => {
        const socialQuery = appService.getSocialQueryService();
        const health = appService.getRuntimeHealth();
        const networkService = appService.getNetworkService();

        setTotalPosts(await socialQuery.getPostCount());
        setTotalProfiles(await socialQuery.getProfileCount());
        setTotalComments(formatNullableCount(await socialQuery.getCommentCount()));
        setTotalReactions(formatNullableCount(await socialQuery.getReactionCount()));
        setTotalFollows(formatNullableCount(await socialQuery.getFollowCount()));
        setPendingSyncQueue(health.sync.pending);
        setReplicationStatus(
          networkService.getConnectedPeers().length > 0 ? 'connected' : 'waiting-peers',
        );
        setDatabaseStats(
          `${health.transports.messagesSent} sent / ${health.transports.messagesReceived} received`,
        );
        setLastSync(
          health.sync.lastSyncTimestamp
            ? new Date(health.sync.lastSyncTimestamp).toLocaleTimeString()
            : 'Never',
        );
        setKnownPeers(
          new Set([...networkService.getConnectedPeers(), ...networkService.getDiscoveredPeers()])
            .size,
        );
      })
      .catch(() => {
        setReplicationStatus('unavailable');
      });
  }, []);

  useEffect(() => {
    refreshStats();
    // eslint-disable-next-line no-undef
    const interval = setInterval(refreshStats, 1000);

    return () => {
      // eslint-disable-next-line no-undef
      clearInterval(interval);
    };
  }, [refreshStats]);

  return (
    <Screen>
      <div className="h-full overflow-y-auto p-4 pb-24 space-y-4">
        <Text variant="heading" tone="primary">
          Social Inspector
        </Text>

        <Card>
          <div className="space-y-3">
            <Text variant="bodySmall" tone="secondary">
              Content Statistics
            </Text>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Text variant="caption" tone="muted">
                  Total Posts
                </Text>
                <Text variant="body" tone="primary">
                  {totalPosts}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Total Profiles
                </Text>
                <Text variant="body" tone="primary">
                  {totalProfiles}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Total Comments
                </Text>
                <Text variant="body" tone="primary">
                  {totalComments}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Total Reactions
                </Text>
                <Text variant="body" tone="primary">
                  {totalReactions}
                </Text>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="space-y-3">
            <Text variant="bodySmall" tone="secondary">
              Network Statistics
            </Text>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Text variant="caption" tone="muted">
                  Total Follows
                </Text>
                <Text variant="body" tone="primary">
                  {totalFollows}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Known Peers
                </Text>
                <Text variant="body" tone="primary">
                  {knownPeers}
                </Text>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="space-y-3">
            <Text variant="bodySmall" tone="secondary">
              Synchronization Status
            </Text>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Text variant="caption" tone="muted">
                  Pending Sync Queue
                </Text>
                <Text variant="body" tone="primary">
                  {pendingSyncQueue}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Replication Status
                </Text>
                <Text variant="body" tone="primary">
                  {replicationStatus}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Last Sync
                </Text>
                <Text variant="body" tone="primary">
                  {lastSync}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Database Stats
                </Text>
                <Text variant="body" tone="primary">
                  {databaseStats}
                </Text>
              </div>
            </div>
          </div>
        </Card>

        <Button
          variant="primary"
          fullWidth
          label="Refresh Statistics"
          onPress={() => {
            refreshStats();
          }}
        />
      </div>
    </Screen>
  );
}

function formatNullableCount(value: number | null): string {
  return value === null ? 'Indisponivel' : String(value);
}
