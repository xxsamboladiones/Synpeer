import React from 'react';
import { View, StyleSheet } from 'react-native';

interface SkeletonLoaderProps {
  width?: number;
  height?: number;
  borderRadius?: number;
}

export function SkeletonLoader({
  width = 100,
  height = 20,
  borderRadius = 4,
}: SkeletonLoaderProps) {
  return <View style={[styles.skeleton, { width: `${width}%`, height, borderRadius }]} />;
}

export function PostCardSkeleton() {
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <SkeletonLoader width={40} height={40} borderRadius={20} />
        <View style={styles.headerContent}>
          <SkeletonLoader width={120} height={16} />
          <SkeletonLoader width={80} height={12} />
        </View>
      </View>
      <SkeletonLoader height={60} />
      <View style={styles.footer}>
        <SkeletonLoader width={40} height={16} />
        <SkeletonLoader width={40} height={16} />
        <SkeletonLoader width={40} height={16} />
      </View>
    </View>
  );
}

export function ProfileSkeleton() {
  return (
    <View style={styles.profileContainer}>
      <SkeletonLoader width={100} height={100} borderRadius={50} />
      <SkeletonLoader width={150} height={24} />
      <SkeletonLoader width={200} height={14} />
      <SkeletonLoader width={180} height={16} />
      <View style={styles.statsRow}>
        <SkeletonLoader width={60} height={40} />
        <SkeletonLoader width={60} height={40} />
        <SkeletonLoader width={60} height={40} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  skeleton: {
    backgroundColor: '#1C1C1E',
  },
  card: {
    backgroundColor: '#0A0A0F',
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#1C1C1E',
  },
  header: {
    flexDirection: 'row',
    marginBottom: 12,
  },
  headerContent: {
    flex: 1,
    marginLeft: 12,
    gap: 4,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#1C1C1E',
  },
  profileContainer: {
    alignItems: 'center',
    padding: 16,
    gap: 8,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    width: '100%',
    marginTop: 16,
  },
});
