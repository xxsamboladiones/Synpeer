import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { useTheme } from '@/styles/theme';

import { Text } from './Text';

export type LoadingProps = {
  label?: string;
};

export function Loading({ label }: LoadingProps) {
  const { theme } = useTheme();

  return (
    <View accessibilityRole="progressbar" style={styles.base}>
      <ActivityIndicator color={theme.colors.accent.neonGreen} />
      {label ? (
        <Text variant="caption" tone="muted">
          {label}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
});
