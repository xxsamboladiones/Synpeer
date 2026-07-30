import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Clipboard } from 'react-native';
import { appService } from '@/services/AppService';
import type { Wallet, Transaction } from '@/economy/RewardTypes';
import { defaultInflationConfig, defaultRewardPoolWeights } from '@/economy/RewardTypes';

export default function WalletScreen() {
  const [walletService, setWalletService] = useState<ReturnType<
    typeof appService.getWalletService
  > | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingRewards, setPendingRewards] = useState(0);
  const [totalSupply, setTotalSupply] = useState(0);
  const [dailyRewards, setDailyRewards] = useState(0);

  useEffect(() => {
    const initializeWallet = async () => {
      try {
        console.log('[WalletScreen] Starting initialization...');
        await appService.initialize();
        console.log('[WalletScreen] AppService initialized');
        setWalletService(appService.getWalletService());
        console.log('[WalletScreen] Wallet service set');
      } catch (error) {
        console.error('[WalletScreen] Failed to initialize:', error);
        // Continue even if initialization fails
        setLoading(false);
      }
    };
    initializeWallet();
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

      // Calculate pending rewards
      const pending = allTransactions
        .filter((t: Transaction) => t.type === 'REWARD' && t.status === 'PENDING')
        .reduce((sum: number, t: Transaction) => sum + t.amount, 0);
      setPendingRewards(pending);

      const issued = allTransactions
        .filter(
          (transaction) =>
            transaction.status === 'CONFIRMED' &&
            (transaction.type === 'REWARD' || transaction.type === 'BONUS'),
        )
        .reduce((sum, transaction) => sum + transaction.amount, 0);
      const burned = allTransactions
        .filter(
          (transaction) => transaction.status === 'CONFIRMED' && transaction.type === 'PENALTY',
        )
        .reduce((sum, transaction) => sum + transaction.amount, 0);
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      setTotalSupply(Math.max(0, issued - burned));
      setDailyRewards(
        allTransactions
          .filter(
            (transaction) =>
              transaction.status === 'CONFIRMED' &&
              transaction.type === 'REWARD' &&
              transaction.timestamp >= todayStart.getTime(),
          )
          .reduce((sum, transaction) => sum + transaction.amount, 0),
      );
    } catch (error) {
      console.error('[WalletScreen] Failed to load data:', error);
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

  const handleCopyAddress = () => {
    if (wallet?.address) {
      Clipboard.setString(wallet.address);
      Alert.alert('Success', 'Address copied to clipboard');
    }
  };

  const handleShowQR = () => {
    if (!wallet?.address) {
      Alert.alert('Wallet', 'No wallet address available');
      return;
    }

    Clipboard.setString(`synpeer:${wallet.address}`);
    Alert.alert('Wallet Address', 'Payment URI copied to clipboard');
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading wallet...</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <View style={styles.header}>
        <Text style={styles.title}>Wallet</Text>
      </View>

      {wallet && (
        <View style={styles.balanceCard}>
          <Text style={styles.balanceLabel}>Current Balance</Text>
          <Text style={styles.balance}>{wallet.balance.toFixed(2)} INSTA</Text>
          <View style={styles.balanceActions}>
            <TouchableOpacity style={styles.balanceButton} onPress={handleCopyAddress}>
              <Text style={styles.balanceButtonText}>📋 Copy Address</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.balanceButton} onPress={handleShowQR}>
              <Text style={styles.balanceButtonText}>📱 QR Code</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {pendingRewards > 0 && (
        <View style={styles.pendingCard}>
          <Text style={styles.pendingLabel}>Pending Rewards</Text>
          <Text style={styles.pendingAmount}>{pendingRewards.toFixed(2)} INSTA</Text>
          <Text style={styles.pendingSubtext}>Processing...</Text>
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Wallet Address</Text>
        <View style={styles.addressCard}>
          <Text style={styles.addressText} numberOfLines={1}>
            {wallet?.address || 'No wallet'}
          </Text>
          <TouchableOpacity onPress={handleCopyAddress}>
            <Text style={styles.copyIcon}>📋</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Reward Categories</Text>
        <View style={styles.categoriesGrid}>
          <View style={styles.categoryCard}>
            <Text style={styles.categoryIcon}>💾</Text>
            <Text style={styles.categoryName}>Storage</Text>
            <Text style={styles.categoryValue}>
              {Math.round(defaultRewardPoolWeights.STORAGE * 100)}%
            </Text>
          </View>
          <View style={styles.categoryCard}>
            <Text style={styles.categoryIcon}>📡</Text>
            <Text style={styles.categoryName}>Bandwidth</Text>
            <Text style={styles.categoryValue}>
              {Math.round(defaultRewardPoolWeights.BANDWIDTH * 100)}%
            </Text>
          </View>
          <View style={styles.categoryCard}>
            <Text style={styles.categoryIcon}>🎬</Text>
            <Text style={styles.categoryName}>Streaming</Text>
            <Text style={styles.categoryValue}>
              {Math.round(defaultRewardPoolWeights.STREAMING * 100)}%
            </Text>
          </View>
          <View style={styles.categoryCard}>
            <Text style={styles.categoryIcon}>🔄</Text>
            <Text style={styles.categoryName}>Replication</Text>
            <Text style={styles.categoryValue}>
              {Math.round(defaultRewardPoolWeights.REPLICATION * 100)}%
            </Text>
          </View>
          <View style={styles.categoryCard}>
            <Text style={styles.categoryIcon}>✅</Text>
            <Text style={styles.categoryName}>Availability</Text>
            <Text style={styles.categoryValue}>
              {Math.round(defaultRewardPoolWeights.AVAILABILITY * 100)}%
            </Text>
          </View>
          <View style={styles.categoryCard}>
            <Text style={styles.categoryIcon}>👥</Text>
            <Text style={styles.categoryName}>Community</Text>
            <Text style={styles.categoryValue}>
              {Math.round(defaultRewardPoolWeights.COMMUNITY * 100)}%
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Emission Statistics</Text>
        <View style={styles.statsCard}>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Daily Emission</Text>
            <Text style={styles.statValue}>
              {defaultInflationConfig.dailyLimit.toLocaleString()} INSTA
            </Text>
          </View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Remaining Today</Text>
            <Text style={styles.statValue}>
              {Math.max(0, defaultInflationConfig.dailyLimit - dailyRewards).toLocaleString()} INSTA
            </Text>
          </View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Total Supply</Text>
            <Text style={styles.statValue}>{totalSupply.toLocaleString()} INSTA</Text>
          </View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Max Supply</Text>
            <Text style={styles.statValue}>
              {defaultInflationConfig.maxSupply.toLocaleString()} INSTA
            </Text>
          </View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Inflation Rate</Text>
            <Text style={styles.statValue}>
              {Math.round(defaultInflationConfig.annualReduction * 100)}%
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Transaction History</Text>
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
        <Text style={styles.sectionTitle}>Ledger</Text>
        <View style={styles.ledgerCard}>
          <View style={styles.ledgerRow}>
            <Text style={styles.ledgerLabel}>Total Entries</Text>
            <Text style={styles.ledgerValue}>{transactions.length}</Text>
          </View>
          <View style={styles.ledgerRow}>
            <Text style={styles.ledgerLabel}>Last Updated</Text>
            <Text style={styles.ledgerValue}>
              {transactions.length > 0
                ? new Date(transactions[0].timestamp).toLocaleString()
                : 'N/A'}
            </Text>
          </View>
        </View>
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
  balanceCard: {
    backgroundColor: '#007AFF',
    borderRadius: 16,
    padding: 24,
    marginBottom: 16,
  },
  balanceLabel: {
    fontSize: 14,
    color: '#FFFFFF',
    opacity: 0.8,
    marginBottom: 8,
  },
  balance: {
    fontSize: 36,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 16,
  },
  balanceActions: {
    flexDirection: 'row',
    gap: 12,
  },
  balanceButton: {
    flex: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
  },
  balanceButtonText: {
    fontSize: 14,
    color: '#FFFFFF',
  },
  pendingCard: {
    backgroundColor: '#FF9500',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  pendingLabel: {
    fontSize: 14,
    color: '#FFFFFF',
    opacity: 0.8,
    marginBottom: 4,
  },
  pendingAmount: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 4,
  },
  pendingSubtext: {
    fontSize: 12,
    color: '#FFFFFF',
    opacity: 0.8,
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
  addressCard: {
    backgroundColor: '#0A0A0F',
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1C1C1E',
  },
  addressText: {
    fontSize: 14,
    color: '#FFFFFF',
    flex: 1,
    marginRight: 12,
  },
  copyIcon: {
    fontSize: 20,
  },
  categoriesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  categoryCard: {
    backgroundColor: '#0A0A0F',
    borderRadius: 12,
    padding: 16,
    width: '48%',
    borderWidth: 1,
    borderColor: '#1C1C1E',
    alignItems: 'center',
  },
  categoryIcon: {
    fontSize: 32,
    marginBottom: 8,
  },
  categoryName: {
    fontSize: 14,
    color: '#FFFFFF',
    marginBottom: 4,
  },
  categoryValue: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#007AFF',
  },
  statsCard: {
    backgroundColor: '#0A0A0F',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1C1C1E',
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1C1C1E',
  },
  statLabel: {
    fontSize: 16,
    color: '#FFFFFF',
  },
  statValue: {
    fontSize: 16,
    fontWeight: '600',
    color: '#8E8E93',
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
  ledgerCard: {
    backgroundColor: '#0A0A0F',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1C1C1E',
  },
  ledgerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1C1C1E',
  },
  ledgerLabel: {
    fontSize: 16,
    color: '#FFFFFF',
  },
  ledgerValue: {
    fontSize: 16,
    fontWeight: '600',
    color: '#8E8E93',
  },
});
