import {
  Modal as NativeModal,
  Pressable,
  StyleSheet,
  View,
  type ModalProps as NativeModalProps,
} from 'react-native';

import { useTheme } from '@/styles/theme';

import { Button } from './Button';
import { Text } from './Text';

export type ModalProps = Omit<NativeModalProps, 'transparent' | 'animationType'> & {
  title?: string;
  onClose: () => void;
};

export function Modal({ children, title, onClose, visible, ...props }: ModalProps) {
  const { theme } = useTheme();

  return (
    <NativeModal {...props} animationType="fade" transparent visible={visible}>
      <View style={[styles.overlay, { backgroundColor: theme.colors.surface.overlay }]}>
        <Pressable
          accessibilityLabel="Close modal overlay"
          style={styles.backdrop}
          onPress={onClose}
        />
        <View
          style={[
            styles.content,
            {
              backgroundColor: theme.colors.surface.primary,
              borderColor: theme.colors.border.glow,
              borderRadius: theme.radius.xl,
              padding: theme.spacing[5],
            },
            theme.shadows.neonBlue,
          ]}
        >
          {title ? (
            <Text variant="title" tone="primary">
              {title}
            </Text>
          ) : null}
          {children}
          <Button label="Close" variant="ghost" onPress={onClose} />
        </View>
      </View>
    </NativeModal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
  },
  content: {
    borderWidth: 1,
    gap: 18,
    maxWidth: 420,
    width: '100%',
  },
});
