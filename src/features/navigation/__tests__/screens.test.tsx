import renderer, { act } from 'react-test-renderer';

import {
  CreateIdentityPlaceholderScreen,
  HomePlaceholderScreen,
  OnboardingScreen,
  ProfilePlaceholderScreen,
  SettingsScreen,
  SplashScreen,
} from '../screens';
import { ThemeProvider } from '@/styles/theme';

describe('navigation base screens', () => {
  const noop = () => undefined;
  const toText = (value: unknown) => JSON.stringify(value);

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders the structural flow screens without domain logic', () => {
    const screens = [
      <SplashScreen key="splash" onReady={noop} />,
      <OnboardingScreen key="onboarding" onStart={noop} />,
      <CreateIdentityPlaceholderScreen key="identity" onContinue={noop} />,
      <HomePlaceholderScreen key="home" onOpenProfile={noop} onOpenSettings={noop} />,
      <ProfilePlaceholderScreen key="profile" />,
      <SettingsScreen key="settings" />,
    ];

    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(<ThemeProvider>{screens}</ThemeProvider>);
    });

    const output = toText(tree!.toJSON());

    expect(output).toContain('Insta99');
    expect(output).toContain('Comecar');
    expect(output).toContain('Criar identidade');
    expect(output).toContain('Fluxo vazio');
    expect(output).toContain('Perfil');
    expect(output).toContain('Configuracoes');

    act(() => {
      tree.unmount();
      jest.runOnlyPendingTimers();
    });
  });
});
