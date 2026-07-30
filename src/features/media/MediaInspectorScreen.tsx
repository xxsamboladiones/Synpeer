import React, { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';

import { Screen } from '@/components/ui';
import { Text } from '@/components/ui/Text';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { appService } from '@/services/AppService';
import type { MediaCacheCleanupResult } from '@/services/media/MediaCacheCleanupService';
import type { StorageHealthSnapshot } from '@/runtime/StorageHealth';

/**
 * MediaInspectorScreen displays media layer statistics for developers
 */
export function MediaInspectorScreen() {
  const [totalMediaObjects, setTotalMediaObjects] = useState<number>(0);
  const [totalChunks, setTotalChunks] = useState<number>(0);
  const [totalStorageSize, setTotalStorageSize] = useState<number>(0);
  const [totalVideos, setTotalVideos] = useState<number>(0);
  const [totalAudio, setTotalAudio] = useState<number>(0);
  const [totalImages, setTotalImages] = useState<number>(0);
  const [totalDocuments, setTotalDocuments] = useState<number>(0);
  const [activeDownloads, setActiveDownloads] = useState<number>(0);
  const [averageChunkSize, setAverageChunkSize] = useState<number>(0);
  const [chunkDistribution, setChunkDistribution] = useState<string>('');
  const [protectedMediaObjects, setProtectedMediaObjects] = useState<number>(0);
  const [orphanMediaObjects, setOrphanMediaObjects] = useState<number>(0);
  const [orphanChunks, setOrphanChunks] = useState<number>(0);
  const [cleanupResult, setCleanupResult] = useState<MediaCacheCleanupResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [cleanupLimitBytes, setCleanupLimitBytes] = useState<number | undefined>(undefined);
  const [storageHealth, setStorageHealth] = useState<StorageHealthSnapshot | null>(null);

  const refreshStatistics = useCallback(async () => {
    await appService.initialize();
    const snapshot = await appService.getStorageHealth();
    setStorageHealth(snapshot);
    setTotalMediaObjects(snapshot.mediaObjects);
    setTotalChunks(snapshot.chunks);
    setTotalStorageSize(snapshot.mediaChunkBytes);
    setTotalVideos(snapshot.mediaByType.video);
    setTotalAudio(snapshot.mediaByType.audio);
    setTotalImages(snapshot.mediaByType.image);
    setTotalDocuments(snapshot.mediaByType.document);
    setActiveDownloads(snapshot.activeDownloads);
    setAverageChunkSize(Math.round(snapshot.averageChunkBytes / 1024));
    setChunkDistribution(
      snapshot.mediaObjects === 0
        ? 'empty'
        : snapshot.completeMediaObjects === snapshot.mediaObjects
          ? 'complete'
          : `${snapshot.completeMediaObjects}/${snapshot.mediaObjects} complete`,
    );
    setProtectedMediaObjects(snapshot.protectedMediaObjects);
    setOrphanMediaObjects(snapshot.orphanMediaObjects);
    setOrphanChunks(snapshot.orphanChunks);
  }, []);

  const cleanupCache = useCallback(async () => {
    setBusy(true);
    try {
      const result = await appService.cleanupMediaCache({ maxBytes: cleanupLimitBytes });
      setCleanupResult(result);
      await refreshStatistics();
      Alert.alert(
        'Media cache cleanup',
        `Freed ${formatBytes(result.freedBytes)}. Removed ${result.deletedMediaObjects} media object(s) and ${result.deletedChunks} chunk(s).`,
      );
    } finally {
      setBusy(false);
    }
  }, [cleanupLimitBytes, refreshStatistics]);

  const confirmCleanup = useCallback(() => {
    const limitText = cleanupLimitBytes
      ? `The cleanup will try to keep media chunks under ${formatBytes(cleanupLimitBytes)} without deleting media referenced by posts.`
      : 'The cleanup will remove only orphan media and chunks. Media referenced by posts will be preserved.';
    Alert.alert('Safe Cleanup', limitText, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clean',
        style: 'destructive',
        onPress: () => {
          void cleanupCache();
        },
      },
    ]);
  }, [cleanupCache, cleanupLimitBytes]);

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
          Media Inspector
        </Text>

        <Card>
          <div className="space-y-3">
            <Text variant="bodySmall" tone="secondary">
              Media Objects
            </Text>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Text variant="caption" tone="muted">
                  Total Media Objects
                </Text>
                <Text variant="body" tone="primary">
                  {totalMediaObjects}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Total Videos
                </Text>
                <Text variant="body" tone="primary">
                  {totalVideos}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Total Audio
                </Text>
                <Text variant="body" tone="primary">
                  {totalAudio}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Total Images
                </Text>
                <Text variant="body" tone="primary">
                  {totalImages}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Total Documents
                </Text>
                <Text variant="body" tone="primary">
                  {totalDocuments}
                </Text>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="space-y-3">
            <Text variant="bodySmall" tone="secondary">
              Chunk Statistics
            </Text>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Text variant="caption" tone="muted">
                  Total Chunks
                </Text>
                <Text variant="body" tone="primary">
                  {totalChunks}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Active Downloads
                </Text>
                <Text variant="body" tone="primary">
                  {activeDownloads}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Average Chunk Size
                </Text>
                <Text variant="body" tone="primary">
                  {averageChunkSize} KB
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Chunk Distribution
                </Text>
                <Text variant="body" tone="primary">
                  {chunkDistribution}
                </Text>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="space-y-3">
            <Text variant="bodySmall" tone="secondary">
              Storage Statistics
            </Text>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Text variant="caption" tone="muted">
                  Total Storage Size
                </Text>
                <Text variant="body" tone="primary">
                  {formatBytes(totalStorageSize)}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Total App Storage
                </Text>
                <Text variant="body" tone="primary">
                  {formatBytes(storageHealth?.totalUsedBytes ?? totalStorageSize)}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Distributed Keys
                </Text>
                <Text variant="body" tone="primary">
                  {storageHealth?.totalKeys ?? 0}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Protected Media
                </Text>
                <Text variant="body" tone="primary">
                  {protectedMediaObjects}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Orphan Media
                </Text>
                <Text variant="body" tone="primary">
                  {orphanMediaObjects}
                </Text>
              </div>
              <div>
                <Text variant="caption" tone="muted">
                  Orphan Chunks
                </Text>
                <Text variant="body" tone="primary">
                  {orphanChunks}
                </Text>
              </div>
            </div>
          </div>
        </Card>

        {cleanupResult ? (
          <Card>
            <div className="space-y-3">
              <Text variant="bodySmall" tone="secondary">
                Last Cleanup
              </Text>
              <Text variant="caption" tone="muted">
                Freed {formatBytes(cleanupResult.freedBytes)}. Deleted{' '}
                {cleanupResult.deletedMediaObjects} media object(s) and{' '}
                {cleanupResult.deletedChunks} chunk(s). Remaining{' '}
                {formatBytes(cleanupResult.remainingBytes)}.
              </Text>
            </div>
          </Card>
        ) : null}

        <Card>
          <div className="space-y-3">
            <Text variant="bodySmall" tone="secondary">
              Cleanup Limit
            </Text>
            <Text variant="caption" tone="muted">
              Protected media stays on disk even when it exceeds the selected limit.
            </Text>
            <div className="grid grid-cols-2 gap-2">
              {cleanupPresets.map((preset) => (
                <Button
                  key={preset.label}
                  variant={cleanupLimitBytes === preset.bytes ? 'primary' : 'secondary'}
                  fullWidth
                  label={preset.label}
                  onPress={() => setCleanupLimitBytes(preset.bytes)}
                />
              ))}
            </div>
          </div>
        </Card>

        <Button
          variant="primary"
          fullWidth
          label="Refresh Statistics"
          onPress={refreshStatistics}
        />
        <Button
          variant="secondary"
          fullWidth
          label={busy ? 'Cleaning...' : 'Safe Cleanup'}
          onPress={() => {
            confirmCleanup();
          }}
          disabled={busy}
        />
      </div>
    </Screen>
  );
}

const cleanupPresets: Array<{ label: string; bytes?: number }> = [
  { label: 'Orphans only', bytes: undefined },
  { label: '250 MB', bytes: 250 * 1024 * 1024 },
  { label: '500 MB', bytes: 500 * 1024 * 1024 },
  { label: '1 GB', bytes: 1024 * 1024 * 1024 },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
