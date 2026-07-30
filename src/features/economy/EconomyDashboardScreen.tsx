import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { WalletService } from '../../economy/Wallet/WalletService';
import type { Wallet, Transaction } from '../../economy/RewardTypes';

/**
 * Economy Dashboard Screen displays wallet balance, rewards, charts, history, and rankings
 */
export const EconomyDashboardScreen: React.FC = () => {
  const [walletService] = useState(() => new WalletService());
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [statistics, setStatistics] = useState({
    totalRewards: 0,
    totalTransfers: 0,
    totalFees: 0,
    averageReward: 0,
  });

  const loadWalletData = useCallback(async () => {
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

      setStatistics({
        totalRewards,
        totalTransfers,
        totalFees,
        averageReward,
      });
    } catch (error) {
      console.error('[EconomyDashboard] Failed to load wallet data:', error);
    } finally {
      setLoading(false);
    }
  }, [walletService]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadWalletData();
  }, [loadWalletData]);

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading economy data...</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Economy Dashboard</Text>
        {wallet && (
          <View style={styles.walletCard}>
            <Text style={styles.walletLabel}>Wallet Balance</Text>
            <Text style={styles.balance}>{wallet.balance.toFixed(2)} INSTA</Text>
            <Text style={styles.walletAddress}>{wallet.address}</Text>
          </View>
        )}
      </View>

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
        <Text style={styles.sectionTitle}>Recent Transactions</Text>
        {transactions.length === 0 ? (
          <Text style={styles.emptyText}>No transactions yet</Text>
        ) : (
          transactions.slice(0, 10).map((transaction) => (
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
              {transaction.description && (
                <Text style={styles.transactionDescription}>{transaction.description}</Text>
              )}
            </View>
          ))
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Reward Breakdown</Text>
        <View style={styles.breakdownCard}>
          <View style={styles.breakdownItem}>
            <View style={[styles.breakdownBar, { backgroundColor: '#007AFF' }]} />
            <Text style={styles.breakdownLabel}>Storage</Text>
          </View>
          <View style={styles.breakdownItem}>
            <View style={[styles.breakdownBar, { backgroundColor: '#5856D6' }]} />
            <Text style={styles.breakdownLabel}>Bandwidth</Text>
          </View>
          <View style={styles.breakdownItem}>
            <View style={[styles.breakdownBar, { backgroundColor: '#FF9500' }]} />
            <Text style={styles.breakdownLabel}>Streaming</Text>
          </View>
          <View style={styles.breakdownItem}>
            <View style={[styles.breakdownBar, { backgroundColor: '#FF3B30' }]} />
            <Text style={styles.breakdownLabel}>Replication</Text>
          </View>
          <View style={styles.breakdownItem}>
            <View style={[styles.breakdownBar, { backgroundColor: '#34C759' }]} />
            <Text style={styles.breakdownLabel}>Availability</Text>
          </View>
          <View style={styles.breakdownItem}>
            <View style={[styles.breakdownBar, { backgroundColor: '#AF52DE' }]} />
            <Text style={styles.breakdownLabel}>Community</Text>
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Rankings</Text>
        <View style={styles.rankingsCard}>
          <Text style={styles.rankingsText}>Top contributors by rewards</Text>
          <Text style={styles.rankingsText}>1. Peer A - 5000 INSTA</Text>
          <Text style={styles.rankingsText}>2. Peer B - 4500 INSTA</Text>
          <Text style={styles.rankingsText}>3. Peer C - 4000 INSTA</Text>
        </View>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  header: {
    padding: 20,
    backgroundColor: '#FFFFFF',
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#000000',
    marginBottom: 20,
  },
  walletCard: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    padding: 20,
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
    paddingHorizontal: 20,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#000000',
    marginBottom: 12,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  statCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    width: '48%',
  },
  statLabel: {
    fontSize: 12,
    color: '#8E8E93',
    marginBottom: 4,
  },
  statValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#000000',
  },
  transactionCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  transactionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  transactionType: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#000000',
  },
  transactionStatus: {
    fontSize: 14,
    color: '#8E8E93',
  },
  transactionDetails: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
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
  transactionDescription: {
    fontSize: 14,
    color: '#8E8E93',
    marginTop: 4,
  },
  emptyText: {
    fontSize: 16,
    color: '#8E8E93',
    textAlign: 'center',
    padding: 20,
  },
  breakdownCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
  },
  breakdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  breakdownBar: {
    width: 4,
    height: 20,
    borderRadius: 2,
    marginRight: 12,
  },
  breakdownLabel: {
    fontSize: 16,
    color: '#000000',
  },
  rankingsCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
  },
  rankingsText: {
    fontSize: 16,
    color: '#000000',
    marginBottom: 8,
  },
  loadingText: {
    fontSize: 16,
    color: '#8E8E93',
    marginTop: 12,
  },
});
