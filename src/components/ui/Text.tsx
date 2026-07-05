import { Text as NativeText, type TextProps as NativeTextProps, StyleSheet } from 'react-native';

import { useTheme } from '@/styles/theme';

type TextVariant = 'display' | 'heading' | 'title' | 'body' | 'bodySmall' | 'caption';
type TextTone = 'primary' | 'secondary' | 'muted' | 'accent' | 'danger';

export type TextProps = NativeTextProps & {
  variant?: TextVariant;
  tone?: TextTone;
};

export function Text({ variant = 'body', tone = 'primary', style, ...props }: TextProps) {
  const { theme } = useTheme();
  const colorByTone = {
    primary: theme.colors.text.primary,
    secondary: theme.colors.text.secondary,
    muted: theme.colors.text.muted,
    accent: theme.colors.accent.electricBlue,
    danger: theme.colors.feedback.danger,
  };

  return (
    <NativeText
      {...props}
      style={[
        styles.base,
        {
          color: colorByTone[tone],
          fontSize: theme.typography.size[variant],
          lineHeight: theme.typography.lineHeight[variant],
          fontWeight: variant === 'display' || variant === 'heading' ? '700' : '500',
        },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  base: {
    letterSpacing: 0,
  },
});
