import { router } from 'expo-router';

import { OnboardingScreen } from '@/features/navigation/screens';

export default function OnboardingRoute() {
  return <OnboardingScreen onStart={() => router.push('/identity/create')} />;
}
