import { StyleSheet, View } from 'react-native';

import { Card, Divider, Screen, Text } from '@/components/ui';

import { NavigationAction } from '../components/NavigationAction';

type OnboardingScreenProps = {
  onStart: () => void;
};

const slides = [
  {
    title: 'Sua presenca, seu dispositivo',
    description: 'Uma base pensada para uma rede descentralizada, sem servidor central nesta fase.',
  },
  {
    title: 'Interface limpa',
    description: 'Dark mode, contraste alto e componentes reutilizaveis desde o primeiro fluxo.',
  },
  {
    title: 'Preparada para crescer',
    description: 'Navegacao estrutural hoje, dominio real apenas quando a fase pedir.',
  },
];

export function OnboardingScreen({ onStart }: OnboardingScreenProps) {
  return (
    <Screen>
      <View style={styles.content}>
        <View style={styles.hero}>
          <Text variant="heading">Comece pelo essencial</Text>
          <Text variant="body" tone="secondary">
            Uma experiencia visual pronta para evoluir com calma.
          </Text>
        </View>
        <View style={styles.slides}>
          {slides.map((slide, index) => (
            <Card key={slide.title} elevated={false}>
              <Text variant="caption" tone="accent">
                0{index + 1}
              </Text>
              <Text variant="title">{slide.title}</Text>
              <Text variant="bodySmall" tone="muted">
                {slide.description}
              </Text>
            </Card>
          ))}
        </View>
        <Divider />
        <NavigationAction label="Comecar" onPress={onStart} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
    gap: 24,
    justifyContent: 'center',
  },
  hero: {
    gap: 8,
  },
  slides: {
    gap: 12,
  },
});
