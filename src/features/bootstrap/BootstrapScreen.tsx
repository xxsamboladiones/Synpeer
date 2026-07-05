import { Card, Screen, Text } from '@/components/ui';

export function BootstrapScreen() {
  return (
    <Screen>
      <Card style={{ marginTop: 'auto', marginBottom: 'auto' }}>
        <Text variant="heading">Insta99</Text>
        <Text variant="body" tone="secondary">
          Fundacao descentralizada em construcao.
        </Text>
      </Card>
    </Screen>
  );
}
