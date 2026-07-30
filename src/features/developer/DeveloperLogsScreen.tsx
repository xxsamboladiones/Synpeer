import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Button, Card, Header, Screen, Text } from '@/components/ui';
import { type LogLevel, setMinimumLogLevel } from '@/observability/Logger';

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const STORAGE_KEY = 'synpeer:logLevel';
const LEGACY_STORAGE_KEY = 'insta99:logLevel';

export function DeveloperLogsScreen() {
  const [level, setLevel] = useState<LogLevel>(readPersistedLogLevel);

  useEffect(() => {
    setMinimumLogLevel(level);
  }, [level]);

  function applyLevel(nextLevel: LogLevel) {
    persistLogLevel(nextLevel);
    setMinimumLogLevel(nextLevel);
    setLevel(nextLevel);
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Header title="Developer Logs" subtitle="Controle de verbosidade dos logs estruturados" />

        <Card>
          <Text variant="title">Nivel atual</Text>
          <Text variant="bodySmall" tone="muted">
            {level}
          </Text>
          <View style={styles.buttonGrid}>
            {LOG_LEVELS.map((item) => (
              <Button
                key={item}
                label={item}
                variant={item === level ? 'primary' : 'secondary'}
                onPress={() => applyLevel(item)}
              />
            ))}
          </View>
        </Card>

        <Card>
          <Text variant="title">Observacao</Text>
          <Text variant="bodySmall" tone="muted">
            O projeto ainda nao possui coletor persistente de logs. Esta tela controla o nivel
            emitido no console e persiste a preferencia localmente.
          </Text>
        </Card>
      </ScrollView>
    </Screen>
  );
}

function readPersistedLogLevel(): LogLevel {
  const storage = getBrowserStorage();
  const value = storage?.getItem(STORAGE_KEY) ?? storage?.getItem(LEGACY_STORAGE_KEY);
  if (isLogLevel(value)) {
    storage?.setItem(STORAGE_KEY, value);
  }
  return isLogLevel(value) ? value : 'warn';
}

function persistLogLevel(level: LogLevel): void {
  getBrowserStorage()?.setItem(STORAGE_KEY, level);
}

type BrowserStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function getBrowserStorage(): BrowserStorage | null {
  const scope = globalThis as { localStorage?: BrowserStorage };
  return scope.localStorage ?? null;
}

function isLogLevel(value: unknown): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

const styles = StyleSheet.create({
  buttonGrid: {
    gap: 10,
  },
  content: {
    gap: 16,
    paddingBottom: 96,
  },
});
