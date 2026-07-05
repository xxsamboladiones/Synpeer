import '@/styles/global.css';

import { Slot } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { ThemeProvider } from '@/styles/theme';

export default function RootLayout() {
  return (
    <ThemeProvider>
      <StatusBar style="light" />
      <Slot />
    </ThemeProvider>
  );
}
