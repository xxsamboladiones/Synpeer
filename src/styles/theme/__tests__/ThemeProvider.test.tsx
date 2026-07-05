import { Text as NativeText } from 'react-native';
import renderer, { act } from 'react-test-renderer';

import { ThemeProvider, useTheme } from '../ThemeProvider';

function ThemeProbe() {
  const { colorScheme, theme } = useTheme();

  return <NativeText>{`${colorScheme}:${theme.colors.background.primary}`}</NativeText>;
}

describe('ThemeProvider', () => {
  it('uses dark mode by default', () => {
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <ThemeProvider>
          <ThemeProbe />
        </ThemeProvider>,
      );
    });

    expect(tree!.root.findByType(NativeText).props.children).toBe('dark:#050509');
  });

  it('keeps a light mode structure available without enabling it by default', () => {
    let tree: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <ThemeProvider colorScheme="light">
          <ThemeProbe />
        </ThemeProvider>,
      );
    });

    expect(tree!.root.findByType(NativeText).props.children).toBe('light:#FAFAFC');
  });
});
