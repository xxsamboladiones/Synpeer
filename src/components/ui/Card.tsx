import { Animated, StyleSheet, type ViewProps } from 'react-native';

import { useFadeIn } from '@/hooks/useFadeIn';
import { useTheme } from '@/styles/theme';

export type CardProps = ViewProps & {
  elevated?: boolean;
};

export function Card({ children, elevated = true, style, ...props }: CardProps) {
  const { theme } = useTheme();
  const fadeInStyle = useFadeIn();

  return (
    <Animated.View
      {...props}
      style={[
        styles.base,
        {
          backgroundColor: theme.colors.surface.primary,
          borderColor: theme.colors.border.subtle,
          borderRadius: theme.radius.lg,
          padding: theme.spacing[5],
        },
        elevated && theme.shadows.soft,
        fadeInStyle,
        style,
      ]}
    >
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderWidth: 1,
    gap: 16,
    overflow: 'hidden',
  },
});
