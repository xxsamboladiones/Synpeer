import type { ReactNode } from 'react';
import { StyleSheet, View, type ViewProps } from 'react-native';

import { useTheme } from '@/styles/theme';

import { Text } from './Text';

export type HeaderProps = ViewProps & {
  title: string;
  subtitle?: string;
  rightSlot?: ReactNode;
};

export function Header({ title, subtitle, rightSlot, style, ...props }: HeaderProps) {
  const { theme } = useTheme();

  return (
    <View
      {...props}
      style={[
        styles.base,
        {
          borderBottomColor: theme.colors.border.subtle,
          paddingBottom: theme.spacing[4],
        },
        style,
      ]}
    >
      <View style={styles.copy}>
        <Text variant="title" tone="primary">
          {title}
        </Text>
        {subtitle ? (
          <Text variant="bodySmall" tone="muted">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {rightSlot}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 64,
  },
  copy: {
    flex: 1,
    gap: 2,
  },
});
