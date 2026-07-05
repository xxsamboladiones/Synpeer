import { router } from 'expo-router';

import { SplashScreen } from '@/features/navigation/screens';

export default function SplashRoute() {
  return <SplashScreen onReady={() => router.replace('/onboarding')} />;
}
