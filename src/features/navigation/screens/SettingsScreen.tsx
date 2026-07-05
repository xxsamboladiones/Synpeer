import { StyleSheet, View } from 'react-native';

import { Card, Divider, Header, Screen, Text } from '@/components/ui';

const settingsItems = ['Tema visual', 'Privacidade local', 'Rede futura'];

export function SettingsScreen() {
  return (
    <Screen>
      <View style={styles.content}>
        <Header title="Configuracoes" subtitle="Opcoes visuais sem persistencia" />
        <Card>
          {settingsItems.map((item, index) => (
            <View key={item} style={styles.itemBlock}>
              <View style={styles.item}>
                <Text variant="body">{item}</Text>
                <Text variant="caption" tone="muted">
                  UI only
                </Text>
              </View>
              {index < settingsItems.length - 1 ? <Divider /> : null}
            </View>
          ))}
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
    gap: 24,
  },
  item: {
    gap: 4,
    paddingVertical: 4,
  },
  itemBlock: {
    gap: 14,
  },
});
