import { createContext, type PropsWithChildren, useContext, useMemo } from 'react';

import { createTheme, type AppTheme } from './theme';
import type { ColorSchemeName } from '../tokens';

type ThemeContextValue = {
  colorScheme: ColorSchemeName;
  theme: AppTheme;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

type ThemeProviderProps = PropsWithChildren<{
  colorScheme?: ColorSchemeName;
}>;

export function ThemeProvider({ children, colorScheme = 'dark' }: ThemeProviderProps) {
  const value = useMemo(
    () => ({
      colorScheme,
      theme: createTheme(colorScheme),
    }),
    [colorScheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);

  if (!context) {
    throw new Error('useTheme must be used inside ThemeProvider');
  }

  return context;
}
