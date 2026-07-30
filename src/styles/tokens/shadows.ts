import { colors } from './colors';

const isWebRuntime = typeof globalThis.document !== 'undefined';

function createShadow<TNative extends object>(native: TNative, web: { boxShadow: string }) {
  return (isWebRuntime ? web : native) as TNative & { boxShadow?: string };
}

export const shadows = {
  none: createShadow(
    {
      shadowOpacity: 0,
      elevation: 0,
    },
    { boxShadow: 'none' },
  ),
  soft: createShadow(
    {
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 12 },
      shadowOpacity: 0.24,
      shadowRadius: 24,
      elevation: 8,
    },
    { boxShadow: '0px 12px 24px rgba(0, 0, 0, 0.24)' },
  ),
  neonBlue: createShadow(
    {
      shadowColor: colors.dark.accent.electricBlue,
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.42,
      shadowRadius: 18,
      elevation: 10,
    },
    { boxShadow: `0px 0px 18px ${colors.dark.accent.electricBlue}` },
  ),
  neonGreen: createShadow(
    {
      shadowColor: colors.dark.accent.neonGreen,
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.28,
      shadowRadius: 16,
      elevation: 8,
    },
    { boxShadow: `0px 0px 16px ${colors.dark.accent.neonGreen}` },
  ),
} as const;
