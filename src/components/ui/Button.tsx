import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  type GestureResponderEvent,
  type PressableProps,
} from 'react-native';

import { useTheme } from '@/styles/theme';

import { Text } from './Text';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export type ButtonProps = Omit<PressableProps, 'children'> & {
  label: string;
  variant?: ButtonVariant;
  fullWidth?: boolean;
};

export function Button({
  label,
  variant = 'primary',
  fullWidth = false,
  disabled,
  onPress,
  style,
  ...props
}: ButtonProps) {
  const { theme } = useTheme();
  const [scale] = useState(() => new Animated.Value(1));

  const palette = {
    primary: {
      backgroundColor: theme.colors.accent.electricBlue,
      borderColor: theme.colors.accent.electricBlue,
      textTone: 'primary' as const,
    },
    secondary: {
      backgroundColor: theme.colors.surface.secondary,
      borderColor: theme.colors.border.strong,
      textTone: 'primary' as const,
    },
    ghost: {
      backgroundColor: 'transparent',
      borderColor: theme.colors.border.subtle,
      textTone: 'secondary' as const,
    },
  };

  function animate(toValue: number) {
    Animated.timing(scale, {
      toValue,
      duration: theme.animation.duration.fast,
      useNativeDriver: true,
    }).start();
  }

  async function handlePress(event: GestureResponderEvent) {
    if (disabled) {
      return;
    }

    await Haptics.selectionAsync().catch(() => undefined);
    onPress?.(event);
  }

  return (
    <Pressable
      {...props}
      accessibilityRole="button"
      disabled={disabled}
      onPress={handlePress}
      onPressIn={() => animate(0.97)}
      onPressOut={() => animate(1)}
      style={style}
    >
      {({ pressed }) => (
        <Animated.View
          style={[
            styles.base,
            fullWidth && styles.fullWidth,
            {
              minHeight: 52,
              paddingHorizontal: theme.spacing[5],
              borderRadius: theme.radius.pill,
              backgroundColor: palette[variant].backgroundColor,
              borderColor: pressed ? theme.colors.border.glow : palette[variant].borderColor,
              opacity: disabled ? 0.48 : pressed ? 0.86 : 1,
              transform: [{ scale }],
            },
            variant === 'primary' && theme.shadows.neonBlue,
          ]}
        >
          <Text variant="body" tone={variant === 'primary' ? 'primary' : palette[variant].textTone}>
            {label}
          </Text>
        </Animated.View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'center',
  },
  fullWidth: {
    width: '100%',
  },
});
