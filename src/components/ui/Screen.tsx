import { Animated, StyleSheet, View, type ViewProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useFadeIn } from '@/hooks/useFadeIn';
import { useTheme } from '@/styles/theme';

export type ScreenProps = ViewProps & {
  padded?: boolean;
  animated?: boolean;
};

export function Screen({ children, padded = true, animated = true, style, ...props }: ScreenProps) {
  const { theme } = useTheme();
  const fadeInStyle = useFadeIn();
  const Container = animated ? Animated.View : View;

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.colors.background.primary }]}>
      <Container
        {...props}
        style={[
          styles.content,
          padded && { paddingHorizontal: theme.spacing[5], paddingVertical: theme.spacing[4] },
          animated && fadeInStyle,
          style,
        ]}
      >
        {children}
      </Container>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
});
