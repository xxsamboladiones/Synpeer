import { StyleSheet, View } from 'react-native';

import { Avatar, Card, Header, Screen, Skeleton, Text } from '@/components/ui';

import { EmptyState } from '../components/EmptyState';

export function ProfilePlaceholderScreen() {
  return (
    <Screen>
      <View style={styles.content}>
        <Header title="Perfil" subtitle="Estrutura visual sem dados de usuario" />
        <Card>
          <View style={styles.profileHeader}>
            <Avatar label="Insta99" size={84} />
            <View style={styles.profileCopy}>
              <Text variant="title">Identidade local</Text>
              <Text variant="bodySmall" tone="muted">
                Dados reais entram somente na etapa correta.
              </Text>
            </View>
          </View>
          <View style={styles.metrics}>
            <Skeleton animated={false} height={16} width="30%" />
            <Skeleton animated={false} height={16} width="30%" />
            <Skeleton animated={false} height={16} width="30%" />
          </View>
        </Card>
        <EmptyState
          title="Perfil vazio"
          description="Nenhuma bio, post ou contribuicao nesta fase."
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
    gap: 24,
  },
  metrics: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  profileCopy: {
    flex: 1,
    gap: 4,
  },
  profileHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 16,
  },
});
