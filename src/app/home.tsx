import { router } from 'expo-router';

import { HomePlaceholderScreen } from '@/features/navigation/screens';

export default function HomeRoute() {
  return (
    <HomePlaceholderScreen
      onOpenProfile={() => router.push('/profile')}
      onOpenSettings={() => router.push('/settings')}
    />
  );
}
