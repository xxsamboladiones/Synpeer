import { colors } from './colors';

export const shadows = {
  none: {
    shadowOpacity: 0,
    elevation: 0,
  },
  soft: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.24,
    shadowRadius: 24,
    elevation: 8,
  },
  neonBlue: {
    shadowColor: colors.dark.accent.electricBlue,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.42,
    shadowRadius: 18,
    elevation: 10,
  },
  neonGreen: {
    shadowColor: colors.dark.accent.neonGreen,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.28,
    shadowRadius: 16,
    elevation: 8,
  },
} as const;
