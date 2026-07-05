import { StyleSheet, View } from 'react-native';

import { Card, Text } from '@/components/ui';
import { useTheme } from '@/styles/theme';

type EmptyStateProps = {
  title: string;
  description: string;
};

export function EmptyState({ title, description }: EmptyStateProps) {
  const { theme } = useTheme();

  return (
    <Card elevated={false} style={styles.card}>
      <View
        style={[
          styles.mark,
          {
            borderColor: theme.colors.border.glow,
            backgroundColor: theme.colors.surface.secondary,
          },
          theme.shadows.neonBlue,
        ]}
      />
      <View style={styles.copy}>
        <Text variant="title">{title}</Text>
        <Text variant="bodySmall" tone="muted">
          {description}
        </Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
  },
  copy: {
    alignItems: 'center',
    gap: 6,
  },
  mark: {
    borderRadius: 999,
    borderWidth: 1,
    height: 56,
    width: 56,
  },
});
