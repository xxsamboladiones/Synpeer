import { router } from 'expo-router';

import { CreateIdentityPlaceholderScreen } from '@/features/navigation/screens';

export default function CreateIdentityRoute() {
  return <CreateIdentityPlaceholderScreen onContinue={() => router.replace('/home')} />;
}
