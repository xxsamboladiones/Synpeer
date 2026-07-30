import React, { useCallback, useEffect, useState } from 'react';

import { Screen } from '@/components/ui';
import { Text } from '@/components/ui/Text';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { appService } from '@/services/AppService';

/**
 * ContributionDashboardScreen displays contribution statistics for developers
 */
export function ContributionDashboardScreen() {
  const [totalStorageShared, setTotalStorageShared] = useState<number>(0);
  const [totalBandwidthShared, setTotalBandwidthShared] = useState<number>(0);
  const [totalChunksServed, setTotalChunksServed] = useState<number>(0);
  const [averageUptime, setAverageUptime] = useState<number>(0);
  const [averageTrustScore, setAverageTrustScore] = useState<number>(0);
  const [topContributors, setTopContributors] = useState<number>(0);
  const [contributionScore, setContributionScore] = useState<number>(0);
  const [trustScore, setTrustScore] = useState<number>(0);
  const [storageShared, setStorageShared] = useState<number>(0);
  const [bandwidthShared, setBandwidthShared] = useState<number>(0);
  const [chunksServed, setChunksServed] = useState<number>(0);
  const [peersHelped, setPeersHelped] = useState<number>(0);
  const [timeOnline, setTimeOnline] = useState<number>(0);

  const refreshStatistics = useCallback(async () => {
    await appService.initialize();
    const contributionEngine = appService.getContributionEngine();
    const trustEngine = appService.getTrustEngine();
    const integration = appService.getContributionNetworkIntegration();
    const localPeerId = appService.getLocalPeerId();
    const statistics = contributionEngine.getStatistics();
    const localMetrics = localPeerId ? contributionEngine.getMetrics(localPeerId) : null;
    const localScore = localPeerId ? contributionEngine.getScore(localPeerId) : null;
    const localTrust = localPeerId ? trustEngine.getTrustScore(localPeerId) : null;

    setTotalStorageShared(Math.round(statistics.totalStorageShared / (1024 * 1024 * 1024)));
    setTotalBandwidthShared(Math.round(statistics.totalBandwidthShared / (1024 * 1024 * 1024)));
    setTotalChunksServed(statistics.totalChunksServed);
    setAverageUptime(Math.round(statistics.averageUptime / 3600));
    setAverageTrustScore(
      Math.round(trustEngine.getAverageTrustScore() || statistics.averageTrustScore),
    );
    setTopContributors(statistics.topContributors.length);
    setContributionScore(Math.round(localScore?.totalScore ?? 0));
    setTrustScore(Math.round(localTrust?.score ?? 0));
    setStorageShared(Math.round((localMetrics?.storageShared ?? 0) / (1024 * 1024)));
    setBandwidthShared(Math.round((localMetrics?.bandwidthShared ?? 0) / (1024 * 1024)));
    setChunksServed(localMetrics?.chunksServed ?? 0);
    setPeersHelped(trustEngine.getAllTrustScores().length);
    setTimeOnline(Math.round(integration.getUptime() / 3600000));
  }, []);

  useEffect(() => {
    const initialRefresh = globalThis.setTimeout(() => {
      void refreshStatistics();
    }, 0);
    const interval = globalThis.setInterval(() => {
      void refreshStatistics();
    }, 5000);

    return () => {
      globalThis.clearTimeout(initialRefresh);
      globalThis.clearInterval(interval);
    };
  }, [refreshStatistics]);

  return (
    <Screen>
      <div className="p-4 space-y-4">
        <Text variant="heading" tone="primary">
          Contribution Dashboard
        </Text>

        <Card>
          <div className="space-y-3">
            <Text variant="bodySmall" tone="secondary">
              My Contribution
            </Text>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Text variant="caption" tone="muted">
                  Contribution Score
                </Text>
                <Text variant="body" tone="primary">
                  {contributionScore}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Trust Score
                </Text>
                <Text variant="body" tone="primary">
                  {trustScore}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Storage Shared
                </Text>
                <Text variant="body" tone="primary">
                  {storageShared} MB
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Bandwidth Shared
                </Text>
                <Text variant="body" tone="primary">
                  {bandwidthShared} MB
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Chunks Served
                </Text>
                <Text variant="body" tone="primary">
                  {chunksServed}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Peers Helped
                </Text>
                <Text variant="body" tone="primary">
                  {peersHelped}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Time Online
                </Text>
                <Text variant="body" tone="primary">
                  {timeOnline}h
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
                  Total Storage Shared
                </Text>
                <Text variant="body" tone="primary">
                  {totalStorageShared} GB
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Total Bandwidth Shared
                </Text>
                <Text variant="body" tone="primary">
                  {totalBandwidthShared} GB
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Total Chunks Served
                </Text>
                <Text variant="body" tone="primary">
                  {totalChunksServed}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Average Uptime
                </Text>
                <Text variant="body" tone="primary">
                  {averageUptime}h
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Average Trust Score
                </Text>
                <Text variant="body" tone="primary">
                  {averageTrustScore}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Top Contributors
                </Text>
                <Text variant="body" tone="primary">
                  {topContributors}
                </Text>
              </div>
            </div>
          </div>
        </Card>

        <Button
          variant="primary"
          fullWidth
          label="Refresh Statistics"
          onPress={refreshStatistics}
        />
      </div>
    </Screen>
  );
}
