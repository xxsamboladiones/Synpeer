import { StyleSheet, View } from 'react-native';

import { Button, Header, Screen, Skeleton, Text } from '@/components/ui';

import { EmptyState } from '../components/EmptyState';

type HomePlaceholderScreenProps = {
  onOpenProfile: () => void;
  onOpenSettings: () => void;
};

export function HomePlaceholderScreen({
  onOpenProfile,
  onOpenSettings,
}: HomePlaceholderScreenProps) {
  return (
    <Screen>
      <View style={styles.content}>
        <Header
          title="Fluxo vazio"
          subtitle="Home estrutural sem feed real"
          rightSlot={
            <View style={styles.actions}>
              <Button label="Perfil" variant="ghost" onPress={onOpenProfile} />
              <Button label="Ajustes" variant="ghost" onPress={onOpenSettings} />
            </View>
          }
        />
        <View style={styles.skeletonGroup}>
          <Skeleton height={18} width="72%" />
          <Skeleton height={120} />
          <Skeleton height={18} width="44%" />
        </View>
        <EmptyState
          title="Nenhum conteudo ainda"
          description="Este espaco sera usado por experiencias futuras, quando a fase permitir."
        />
        <Text variant="caption" tone="muted">
          Placeholder visual. Sem posts, curtidas ou comentarios.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: 8,
  },
  content: {
    flex: 1,
    gap: 24,
  },
  skeletonGroup: {
    gap: 12,
  },
});
