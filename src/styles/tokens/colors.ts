export const colors = {
  dark: {
    background: {
      primary: '#050509',
      secondary: '#0A0A12',
      elevated: '#11111D',
    },
    surface: {
      primary: '#141421',
      secondary: '#1B1B2A',
      tertiary: '#26263A',
      overlay: 'rgba(5, 5, 9, 0.78)',
    },
    border: {
      subtle: '#2A2A3D',
      strong: '#3B3B54',
      glow: 'rgba(51, 163, 255, 0.42)',
    },
    text: {
      primary: '#F8FAFC',
      secondary: '#C7CAD5',
      muted: '#858A9B',
      inverse: '#050509',
    },
    accent: {
      electricBlue: '#33A3FF',
      neonGreen: '#39FF88',
      hotPink: '#FF3DF2',
      violet: '#8E5CFF',
    },
    feedback: {
      success: '#39FF88',
      warning: '#FFD166',
      danger: '#FF4D6D',
    },
  },
  light: {
    background: {
      primary: '#FAFAFC',
      secondary: '#F0F1F6',
      elevated: '#FFFFFF',
    },
    surface: {
      primary: '#FFFFFF',
      secondary: '#F3F4F8',
      tertiary: '#E8EAF1',
      overlay: 'rgba(250, 250, 252, 0.82)',
    },
    border: {
      subtle: '#D9DCE8',
      strong: '#C3C8D7',
      glow: 'rgba(51, 163, 255, 0.28)',
    },
    text: {
      primary: '#0A0A12',
      secondary: '#373A46',
      muted: '#717789',
      inverse: '#FFFFFF',
    },
    accent: {
      electricBlue: '#006DFF',
      neonGreen: '#00B86B',
      hotPink: '#D100C9',
      violet: '#6F3DFF',
    },
    feedback: {
      success: '#00A861',
      warning: '#B77900',
      danger: '#D92D52',
    },
  },
} as const;

export type ColorSchemeName = keyof typeof colors;
export type ThemeColors = (typeof colors)[ColorSchemeName];
