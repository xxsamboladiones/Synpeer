import { animation, colors, radius, shadows, spacing, typography, zIndex } from '@/styles/tokens';
import type { ColorSchemeName } from '@/styles/tokens';

export function createTheme(colorScheme: ColorSchemeName = 'dark') {
  return {
    colorScheme,
    colors: colors[colorScheme],
    typography,
    spacing,
    radius,
    shadows,
    zIndex,
    animation,
  };
}

export type AppTheme = ReturnType<typeof createTheme>;
