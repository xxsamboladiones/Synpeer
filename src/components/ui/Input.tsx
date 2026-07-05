import { forwardRef, useState } from 'react';
import {
  StyleSheet,
  TextInput,
  type TextInputProps,
  View,
  type TextInput as TextInputRef,
} from 'react-native';

import { useTheme } from '@/styles/theme';

import { Text } from './Text';

export type InputProps = TextInputProps & {
  label?: string;
  error?: string;
};

export const Input = forwardRef<TextInputRef, InputProps>(function Input(
  { label, error, style, ...props },
  ref,
) {
  const { theme } = useTheme();
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.wrapper}>
      {label ? (
        <Text variant="caption" tone="secondary" style={styles.label}>
          {label}
        </Text>
      ) : null}
      <TextInput
        ref={ref}
        {...props}
        placeholderTextColor={theme.colors.text.muted}
        selectionColor={theme.colors.accent.electricBlue}
        onFocus={(event) => {
          setFocused(true);
          props.onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          props.onBlur?.(event);
        }}
        style={[
          styles.input,
          {
            color: theme.colors.text.primary,
            backgroundColor: theme.colors.surface.primary,
            borderColor: error
              ? theme.colors.feedback.danger
              : focused
                ? theme.colors.accent.electricBlue
                : theme.colors.border.subtle,
            borderRadius: theme.radius.lg,
            paddingHorizontal: theme.spacing[4],
          },
          style,
        ]}
      />
      {error ? (
        <Text variant="caption" tone="danger" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrapper: {
    gap: 8,
    width: '100%',
  },
  label: {
    textTransform: 'uppercase',
  },
  input: {
    borderWidth: 1,
    minHeight: 54,
  },
  error: {
    marginTop: 2,
  },
});
