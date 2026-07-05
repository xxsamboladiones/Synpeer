import { Image, StyleSheet, View, type ImageSourcePropType } from 'react-native';

import { useTheme } from '@/styles/theme';

import { Text } from './Text';

export type AvatarProps = {
  label: string;
  source?: ImageSourcePropType;
  size?: number;
};

export function Avatar({ label, source, size = 48 }: AvatarProps) {
  const { theme } = useTheme();
  const initials = label
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

  return (
    <View
      accessibilityLabel={label}
      style={[
        styles.base,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: theme.colors.surface.tertiary,
          borderColor: theme.colors.border.glow,
        },
        theme.shadows.neonGreen,
      ]}
    >
      {source ? (
        <Image source={source} style={{ width: size, height: size, borderRadius: size / 2 }} />
      ) : (
        <Text variant="bodySmall" tone="primary">
          {initials || '?'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    borderWidth: 1,
    justifyContent: 'center',
    overflow: 'hidden',
  },
});
