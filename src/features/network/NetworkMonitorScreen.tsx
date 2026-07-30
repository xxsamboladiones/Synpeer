import React, { useState, useEffect } from 'react';

import { Screen } from '@/components/ui';
import { Text } from '@/components/ui/Text';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import type { NetworkStats } from '@/network/NetworkTypes';
import { appService } from '@/services/AppService';

/**
 * NetworkMonitorScreen displays live network status for developers
 */
export function NetworkMonitorScreen() {
  const [connectedPeers, setConnectedPeers] = useState<number>(0);
  const [totalPeers, setTotalPeers] = useState<number>(0);
  const [messagesSent, setMessagesSent] = useState<number>(0);
  const [messagesReceived, setMessagesReceived] = useState<number>(0);
  const [uptime, setUptime] = useState<number>(0);
  const [reconnectCount, setReconnectCount] = useState<number>(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const [peerId, setPeerId] = useState<string>('Not started');

  useEffect(() => {
    const refreshStats = () => {
      void appService
        .initialize()
        .then(() => {
          const networkService = appService.getNetworkService();
          const peerManager = networkService.getPeerManager();
          const peerConnection = networkService.getPeerConnection();
          const pingProtocol = networkService.getPingProtocol();
          const connectedPeerIds = networkService.getConnectedPeers();
          const discoveredPeerIds = networkService.getDiscoveredPeers();
          const maybeNetwork = networkService as unknown as {
            getTransportStats?: () => { messagesSent: number; messagesReceived: number } | null;
          };
          const transportStats = maybeNetwork.getTransportStats?.() ?? {
            messagesSent: 0,
            messagesReceived: 0,
          };
          const firstPeer = connectedPeerIds[0];

          setPeerId(peerManager.getPeerId() ?? 'Not started');
          setConnectedPeers(connectedPeerIds.length);
          setTotalPeers(new Set([...connectedPeerIds, ...discoveredPeerIds]).size);
          setMessagesSent(transportStats.messagesSent);
          setMessagesReceived(transportStats.messagesReceived);
          setUptime(peerManager.getUptime());
          setReconnectCount(
            peerConnection
              .getAllConnections()
              .reduce((total, connection) => total + connection.reconnectCount, 0),
          );
          setLatency(firstPeer ? pingProtocol.getAverageLatency(firstPeer) : null);
          setErrors([]);
        })
        .catch((error: unknown) => {
          setErrors([error instanceof Error ? error.message : 'Unable to read network state']);
        });
    };

    refreshStats();
    // eslint-disable-next-line no-undef
    const interval = setInterval(refreshStats, 1000);

    return () => {
      // eslint-disable-next-line no-undef
      clearInterval(interval);
    };
  }, []);

  const formatUptime = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  };

  const stats: NetworkStats = {
    connectedPeers,
    totalPeers,
    messagesSent,
    messagesReceived,
    uptime,
    reconnectCount,
  };

  return (
    <Screen>
      <div className="h-full overflow-y-auto p-4 pb-24 space-y-4">
        <Text variant="heading" tone="primary">
          Network Monitor
        </Text>

        <Card>
          <div className="space-y-3">
            <Text variant="bodySmall" tone="secondary">
              Peer ID
            </Text>
            <Text variant="body" tone="primary">
              {peerId}
            </Text>
          </div>
        </Card>

        <Card>
          <div className="space-y-3">
            <Text variant="bodySmall" tone="secondary">
              Connection Status
            </Text>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Text variant="caption" tone="muted">
                  Connected Peers
                </Text>
                <Text variant="body" tone="primary">
                  {stats.connectedPeers}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Total Peers
                </Text>
                <Text variant="body" tone="primary">
                  {stats.totalPeers}
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
                  Messages Sent
                </Text>
                <Text variant="body" tone="primary">
                  {stats.messagesSent}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Messages Received
                </Text>
                <Text variant="body" tone="primary">
                  {stats.messagesReceived}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Uptime
                </Text>
                <Text variant="body" tone="primary">
                  {formatUptime(stats.uptime)}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Reconnect Count
                </Text>
                <Text variant="body" tone="primary">
                  {stats.reconnectCount}
                </Text>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="space-y-3">
            <Text variant="bodySmall" tone="secondary">
              Latency
            </Text>
            <Text variant="body" tone="primary">
              {latency !== null ? `${latency}ms` : 'N/A'}
            </Text>
          </div>
        </Card>

        {errors.length > 0 && (
          <Card>
            <div className="space-y-3">
              <Text variant="bodySmall" tone="danger">
                Errors
              </Text>
              {errors.map((error, index) => (
                <Text key={index} variant="caption" tone="danger">
                  {error}
                </Text>
              ))}
            </div>
          </Card>
        )}

        <Button
          variant="primary"
          fullWidth
          label="Clear Errors"
          onPress={() => {
            // Clear errors
            setErrors([]);
          }}
        />
      </div>
    </Screen>
  );
}
