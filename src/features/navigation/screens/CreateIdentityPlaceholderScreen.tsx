import { StyleSheet, View } from 'react-native';

import { Avatar, Card, Header, Input, Screen, Text } from '@/components/ui';

import { NavigationAction } from '../components/NavigationAction';

type CreateIdentityPlaceholderScreenProps = {
  onContinue: () => void;
};

export function CreateIdentityPlaceholderScreen({
  onContinue,
}: CreateIdentityPlaceholderScreenProps) {
  return (
    <Screen>
      <View style={styles.content}>
        <Header title="Criar identidade" subtitle="UI estrutural sem criptografia nesta etapa" />
        <Card>
          <View style={styles.avatarRow}>
            <Avatar label="Insta99" size={72} />
            <View style={styles.avatarCopy}>
              <Text variant="title">Perfil local</Text>
              <Text variant="bodySmall" tone="muted">
                Campos visuais apenas. Nenhuma identidade sera gerada aqui.
              </Text>
            </View>
          </View>
          <Input editable={false} label="Nome" placeholder="Seu nome publico" value="" />
          <NavigationAction label="Continuar" onPress={onContinue} />
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatarCopy: {
    flex: 1,
    gap: 4,
  },
  avatarRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 16,
  },
  content: {
    flex: 1,
    gap: 24,
  },
});
