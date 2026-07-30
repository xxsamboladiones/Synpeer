import { useEffect, useState } from 'react';
import { Animated, StyleSheet, type ViewStyle } from 'react-native';

import { useTheme } from '@/styles/theme';
import { supportsNativeAnimatedDriver } from '@/utils/animationDriver';

export type SkeletonProps = {
  width?: ViewStyle['width'];
  height?: number;
  radius?: number;
  animated?: boolean;
};

export function Skeleton({ width = '100%', height = 18, radius, animated = true }: SkeletonProps) {
  const { theme } = useTheme();
  const [opacity] = useState(() => new Animated.Value(0.36));

  useEffect(() => {
    if (!animated) {
      return undefined;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.72,
          duration: theme.animation.duration.slow,
          useNativeDriver: supportsNativeAnimatedDriver,
        }),
        Animated.timing(opacity, {
          toValue: 0.36,
          duration: theme.animation.duration.slow,
          useNativeDriver: supportsNativeAnimatedDriver,
        }),
      ]),
    );

    loop.start();

    return () => loop.stop();
  }, [animated, opacity, theme.animation.duration.slow]);

  return (
    <Animated.View
      accessibilityLabel="Loading content"
      style={[
        styles.base,
        {
          width,
          height,
          opacity,
          borderRadius: radius ?? theme.radius.md,
          backgroundColor: theme.colors.surface.tertiary,
          borderColor: theme.colors.border.subtle,
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  base: {
    borderWidth: StyleSheet.hairlineWidth,
  },
});
