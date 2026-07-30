import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { Loading, Screen, Text } from '@/components/ui';

type SplashScreenProps = {
  onReady: () => void;
};

export function SplashScreen({ onReady }: SplashScreenProps) {
  useEffect(() => {
    const timeout = setTimeout(onReady, 900);

    return () => clearTimeout(timeout);
  }, [onReady]);

  return (
    <Screen>
      <View style={styles.content}>
        <Text variant="display">Synpeer</Text>
        <Text variant="body" tone="secondary" style={styles.tagline}>
          Rede social P2P local-first.
        </Text>
        <Loading label="Inicializando rede" />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    alignItems: 'center',
    flex: 1,
    gap: 18,
    justifyContent: 'center',
  },
  tagline: {
    textAlign: 'center',
  },
});
