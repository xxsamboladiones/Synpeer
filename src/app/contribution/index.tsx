import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { appService } from '@/services/AppService';
import type { Wallet, Transaction } from '@/economy/RewardTypes';
import { createLogger } from '@/observability/Logger';

const logger = createLogger('ContributionScreen');

export default function ContributionScreen() {
  const [walletService, setWalletService] = useState<ReturnType<
    typeof appService.getWalletService
  > | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [statistics, setStatistics] = useState({
    totalRewards: 0,
    totalTransfers: 0,
    totalFees: 0,
    averageReward: 0,
  });
  const [metrics, setMetrics] = useState({
    contributionScore: 0,
    trustScore: 0,
    storageShared: 0,
    bandwidthShared: 0,
    chunksServed: 0,
    uptime: 0,
  });

  useEffect(() => {
    const initializeContribution = async () => {
      try {
        logger.info('initialization_started');
        await appService.initialize();
        logger.info('app_service_initialized');
        setWalletService(appService.getWalletService());
        logger.info('wallet_service_ready');
      } catch (error) {
        logger.error('initialization_failed', error);
        setLoading(false);
      }
    };
    initializeContribution();
  }, []);

  const loadWalletData = useCallback(async () => {
    if (!walletService) return;

    try {
      setLoading(true);
      const currentWallet = walletService.getWallet();
      if (currentWallet) {
        setWallet(currentWallet);
      }

      const allTransactions = walletService.getTransactions(50);
      setTransactions(allTransactions);

      // Calculate statistics
      const rewards = allTransactions.filter((t: Transaction) => t.type === 'REWARD');
      const transfers = allTransactions.filter((t: Transaction) => t.type === 'TRANSFER');
      const totalRewards = rewards.reduce((sum: number, t: Transaction) => sum + t.amount, 0);
      const totalTransfers = transfers.reduce((sum: number, t: Transaction) => sum + t.amount, 0);
      const totalFees = allTransactions.reduce((sum: number, t: Transaction) => sum + t.fee, 0);
      const averageReward = rewards.length > 0 ? totalRewards / rewards.length : 0;
      const localPeerId = appService.getLocalPeerId();
      const contributionEngine = appService.getContributionEngine();
      const trustEngine = appService.getTrustEngine();
      const contributionScore = localPeerId
        ? (contributionEngine.getScore(localPeerId)?.totalScore ?? 0)
        : 0;
      const trust = localPeerId ? trustEngine.getTrustScore(localPeerId) : null;
      const contributionMetrics = localPeerId ? contributionEngine.getMetrics(localPeerId) : null;

      setStatistics({
        totalRewards,
        totalTransfers,
        totalFees,
        averageReward,
      });
      setMetrics({
        contributionScore: Math.round(contributionScore),
        trustScore: Math.round(trust?.score ?? 0),
        storageShared: Math.round((contributionMetrics?.storageShared ?? 0) / (1024 * 1024)),
        bandwidthShared: Math.round((contributionMetrics?.bandwidthShared ?? 0) / (1024 * 1024)),
        chunksServed: contributionMetrics?.chunksServed ?? 0,
        uptime: Math.round(trust?.availability ?? 0),
      });
    } catch (error) {
      logger.error('data_load_failed', error);
    } finally {
      setLoading(false);
    }
  }, [walletService]);

  useEffect(() => {
    if (walletService) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadWalletData();
    }
  }, [walletService, loadWalletData]);

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading contribution data...</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <View style={styles.header}>
        <Text style={styles.title}>Contribution</Text>
      </View>

      {wallet && (
        <View style={styles.walletCard}>
          <Text style={styles.walletLabel}>Wallet Balance</Text>
          <Text style={styles.balance}>{wallet.balance.toFixed(2)} INSTA</Text>
          <Text style={styles.walletAddress}>{wallet.address}</Text>
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Statistics</Text>
        <View style={styles.statsGrid}>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Total Rewards</Text>
            <Text style={styles.statValue}>{statistics.totalRewards.toFixed(2)}</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Total Transfers</Text>
            <Text style={styles.statValue}>{statistics.totalTransfers.toFixed(2)}</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Total Fees</Text>
            <Text style={styles.statValue}>{statistics.totalFees.toFixed(2)}</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Avg Reward</Text>
            <Text style={styles.statValue}>{statistics.averageReward.toFixed(2)}</Text>
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Contribution Metrics</Text>
        <View style={styles.metricsCard}>
          <View style={styles.metric}>
            <Text style={styles.metricLabel}>Contribution Score</Text>
            <View style={styles.metricBar}>
              <View
                style={[
                  styles.metricFill,
                  { width: `${Math.min(100, metrics.contributionScore)}%` },
                ]}
              />
            </View>
            <Text style={styles.metricValue}>{metrics.contributionScore}</Text>
          </View>
          <View style={styles.metric}>
            <Text style={styles.metricLabel}>Trust Score</Text>
            <View style={styles.metricBar}>
              <View
                style={[styles.metricFill, { width: `${Math.min(100, metrics.trustScore / 10)}%` }]}
              />
            </View>
            <Text style={styles.metricValue}>{metrics.trustScore}</Text>
          </View>
          <View style={styles.metric}>
            <Text style={styles.metricLabel}>Storage Shared</Text>
            <View style={styles.metricBar}>
              <View
                style={[styles.metricFill, { width: `${Math.min(100, metrics.storageShared)}%` }]}
              />
            </View>
            <Text style={styles.metricValue}>{metrics.storageShared} MB</Text>
          </View>
          <View style={styles.metric}>
            <Text style={styles.metricLabel}>Bandwidth</Text>
            <View style={styles.metricBar}>
              <View
                style={[styles.metricFill, { width: `${Math.min(100, metrics.bandwidthShared)}%` }]}
              />
            </View>
            <Text style={styles.metricValue}>{metrics.bandwidthShared} MB</Text>
          </View>
          <View style={styles.metric}>
            <Text style={styles.metricLabel}>Chunks Served</Text>
            <View style={styles.metricBar}>
              <View
                style={[styles.metricFill, { width: `${Math.min(100, metrics.chunksServed)}%` }]}
              />
            </View>
            <Text style={styles.metricValue}>{metrics.chunksServed}</Text>
          </View>
          <View style={styles.metric}>
            <Text style={styles.metricLabel}>Uptime</Text>
            <View style={styles.metricBar}>
              <View style={[styles.metricFill, { width: `${Math.min(100, metrics.uptime)}%` }]} />
            </View>
            <Text style={styles.metricValue}>{metrics.uptime}%</Text>
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Recent Transactions</Text>
        {transactions.length === 0 ? (
          <Text style={styles.emptyText}>No transactions yet</Text>
        ) : (
          transactions.slice(0, 5).map((transaction) => (
            <View key={transaction.id} style={styles.transactionCard}>
              <View style={styles.transactionHeader}>
                <Text style={styles.transactionType}>{transaction.type}</Text>
                <Text style={styles.transactionStatus}>{transaction.status}</Text>
              </View>
              <View style={styles.transactionDetails}>
                <Text style={styles.transactionAmount}>{transaction.amount.toFixed(2)} INSTA</Text>
                <Text style={styles.transactionDate}>
                  {new Date(transaction.timestamp).toLocaleString()}
                </Text>
              </View>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050509',
  },
  contentContainer: {
    padding: 16,
  },
  header: {
    marginBottom: 20,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  loadingText: {
    fontSize: 16,
    color: '#8E8E93',
    marginTop: 12,
  },
  walletCard: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    padding: 20,
    marginBottom: 20,
  },
  walletLabel: {
    fontSize: 14,
    color: '#FFFFFF',
    opacity: 0.8,
    marginBottom: 8,
  },
  balance: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  walletAddress: {
    fontSize: 12,
    color: '#FFFFFF',
    opacity: 0.6,
  },
  section: {
    marginTop: 20,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 12,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  statCard: {
    backgroundColor: '#0A0A0F',
    borderRadius: 12,
    padding: 16,
    width: '48%',
    borderWidth: 1,
    borderColor: '#1C1C1E',
  },
  statLabel: {
    fontSize: 12,
    color: '#8E8E93',
    marginBottom: 4,
  },
  statValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  metricsCard: {
    backgroundColor: '#0A0A0F',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1C1C1E',
  },
  metric: {
    marginBottom: 16,
  },
  metricLabel: {
    fontSize: 14,
    color: '#FFFFFF',
    marginBottom: 8,
  },
  metricBar: {
    height: 8,
    backgroundColor: '#1C1C1E',
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 4,
  },
  metricFill: {
    height: '100%',
    backgroundColor: '#007AFF',
  },
  metricValue: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  transactionCard: {
    backgroundColor: '#0A0A0F',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#1C1C1E',
  },
  transactionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  transactionType: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  transactionStatus: {
    fontSize: 14,
    color: '#8E8E93',
  },
  transactionDetails: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  transactionAmount: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#007AFF',
  },
  transactionDate: {
    fontSize: 12,
    color: '#8E8E93',
  },
  emptyText: {
    fontSize: 16,
    color: '#8E8E93',
    textAlign: 'center',
    padding: 20,
  },
});
