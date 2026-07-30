import React, { useCallback, useEffect, useState } from 'react';

import { Screen } from '@/components/ui';
import { Text } from '@/components/ui/Text';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { appService } from '@/services/AppService';

/**
 * ConsensusDashboardScreen displays consensus statistics for developers
 */
export function ConsensusDashboardScreen() {
  const [totalRounds, setTotalRounds] = useState<number>(0);
  const [successfulRounds, setSuccessfulRounds] = useState<number>(0);
  const [failedRounds, setFailedRounds] = useState<number>(0);
  const [averageRoundTime, setAverageRoundTime] = useState<number>(0);
  const [totalContributions, setTotalContributions] = useState<number>(0);
  const [totalProofs, setTotalProofs] = useState<number>(0);
  const [totalBundles, setTotalBundles] = useState<number>(0);
  const [averageApprovalRate, setAverageApprovalRate] = useState<number>(0);
  const [fraudReports, setFraudReports] = useState<number>(0);
  const [sybilDetections, setSybilDetections] = useState<number>(0);
  const [activeRounds, setActiveRounds] = useState<number>(0);
  const [pendingEvidence, setPendingEvidence] = useState<number>(0);
  const [totalVotes, setTotalVotes] = useState<number>(0);
  const [quorumSuccessRate, setQuorumSuccessRate] = useState<number>(0);

  const refreshStatistics = useCallback(async () => {
    await appService.initialize();
    const consensusEngine = appService.getConsensusEngine();
    const statistics = consensusEngine.getStatistics();
    const active = consensusEngine.getActiveRounds();
    const voteCount = consensusEngine.getVoteManager().getCount();
    const quorumHistory = consensusEngine.getQuorumManager().getAllQuorumResults();
    const successfulQuorums = quorumHistory.filter((item) => item.reached).length;

    setTotalRounds(statistics.totalRounds);
    setSuccessfulRounds(statistics.successfulRounds);
    setFailedRounds(statistics.failedRounds);
    setAverageRoundTime(Math.round(statistics.averageRoundTime));
    setTotalContributions(statistics.totalContributions);
    setTotalProofs(statistics.totalProofs);
    setTotalBundles(statistics.totalBundles);
    setAverageApprovalRate(Math.round(statistics.averageApprovalRate));
    setFraudReports(statistics.fraudReports);
    setSybilDetections(statistics.sybilDetections);
    setActiveRounds(active.length);
    setPendingEvidence(consensusEngine.getEvidenceManager().getPendingEvidence().length);
    setTotalVotes(voteCount);
    setQuorumSuccessRate(
      quorumHistory.length > 0 ? Math.round((successfulQuorums / quorumHistory.length) * 100) : 0,
    );
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
      <div className="h-full overflow-y-auto p-4 pb-24 space-y-4">
        <Text variant="heading" tone="primary">
          Consensus Dashboard
        </Text>

        <Card>
          <div className="space-y-3">
            <Text variant="bodySmall" tone="secondary">
              Round Statistics
            </Text>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Text variant="caption" tone="muted">
                  Total Rounds
                </Text>
                <Text variant="body" tone="primary">
                  {totalRounds}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Successful Rounds
                </Text>
                <Text variant="body" tone="primary">
                  {successfulRounds}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Failed Rounds
                </Text>
                <Text variant="body" tone="primary">
                  {failedRounds}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Active Rounds
                </Text>
                <Text variant="body" tone="primary">
                  {activeRounds}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Average Round Time
                </Text>
                <Text variant="body" tone="primary">
                  {averageRoundTime}ms
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Quorum Success Rate
                </Text>
                <Text variant="body" tone="primary">
                  {quorumSuccessRate}%
                </Text>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="space-y-3">
            <Text variant="bodySmall" tone="secondary">
              Contribution Statistics
            </Text>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Text variant="caption" tone="muted">
                  Total Contributions
                </Text>
                <Text variant="body" tone="primary">
                  {totalContributions}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Total Proofs
                </Text>
                <Text variant="body" tone="primary">
                  {totalProofs}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Total Bundles
                </Text>
                <Text variant="body" tone="primary">
                  {totalBundles}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Pending Evidence
                </Text>
                <Text variant="body" tone="primary">
                  {pendingEvidence}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Total Votes
                </Text>
                <Text variant="body" tone="primary">
                  {totalVotes}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Average Approval Rate
                </Text>
                <Text variant="body" tone="primary">
                  {averageApprovalRate}%
                </Text>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="space-y-3">
            <Text variant="bodySmall" tone="secondary">
              Security Statistics
            </Text>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Text variant="caption" tone="muted">
                  Fraud Reports
                </Text>
                <Text variant="body" tone="primary">
                  {fraudReports}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Sybil Detections
                </Text>
                <Text variant="body" tone="primary">
                  {sybilDetections}
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
