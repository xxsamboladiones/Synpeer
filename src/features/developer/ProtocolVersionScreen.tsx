import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Button, Card, Header, Screen, Text } from '@/components/ui';
import { MAX_NETWORK_MESSAGE_BYTES, NETWORK_PROTOCOL_VERSION } from '@/network/NetworkMessage';
import type { RuntimeHealthSnapshot } from '@/runtime/RuntimeHealth';
import { appService } from '@/services/AppService';

type ProtocolStatus = {
  health: RuntimeHealthSnapshot | null;
  error: string | null;
};

export function ProtocolVersionScreen() {
  const [status, setStatus] = useState<ProtocolStatus>({ health: null, error: null });

  const refresh = useCallback(async () => {
    try {
      await appService.initialize();
      setStatus({ health: appService.getRuntimeHealth(), error: null });
    } catch (error) {
      setStatus({
        health: null,
        error: error instanceof Error ? error.message : 'Nao foi possivel ler o runtime',
      });
    }
  }, []);

  useEffect(() => {
    const timer = globalThis.setTimeout(() => {
      void refresh();
    }, 0);

    return () => {
      globalThis.clearTimeout(timer);
    };
  }, [refresh]);

  const health = status.health;

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Header title="Protocol Version" subtitle="Envelope de mensagens e runtime atual" />

        <Card>
          <Metric label="Network protocol" value={`v${NETWORK_PROTOCOL_VERSION}`} />
          <Metric
            label="Max message size"
            value={`${Math.round(MAX_NETWORK_MESSAGE_BYTES / 1024)} KB`}
          />
          <Metric label="Runtime state" value={health?.state ?? 'unavailable'} />
          <Metric label="Initialized" value={health ? String(health.initialized) : 'unavailable'} />
        </Card>

        <Card>
          <Metric label="Local peer" value={health?.localPeerId ?? 'sem identidade local'} />
          <Metric label="Connected peers" value={String(health?.network.connectedPeers ?? 0)} />
          <Metric label="Known peers" value={String(health?.network.knownPeers ?? 0)} />
          <Metric label="Manual dial" value={String(health?.network.canDialManualPeer ?? false)} />
        </Card>

        {status.error ? (
          <Card>
            <Text variant="bodySmall" tone="danger">
              {status.error}
            </Text>
          </Card>
        ) : null}

        <Button label="Refresh" onPress={refresh} />
      </ScrollView>
    </Screen>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text variant="bodySmall" tone="muted">
        {label}
      </Text>
      <Text variant="body">{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 16,
    paddingBottom: 96,
  },
  metric: {
    gap: 4,
  },
});
