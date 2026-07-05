import { StyleSheet, View, type ViewProps } from 'react-native';

import { useTheme } from '@/styles/theme';

export function Divider({ style, ...props }: ViewProps) {
  const { theme } = useTheme();

  return (
    <View
      {...props}
      style={[styles.base, { backgroundColor: theme.colors.border.subtle }, style]}
    />
  );
}

const styles = StyleSheet.create({
  base: {
    height: StyleSheet.hairlineWidth,
    width: '100%',
  },
});
