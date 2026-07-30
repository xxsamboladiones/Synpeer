import { router } from 'expo-router';

import { CreateIdentityScreen } from '@/features/identity/CreateIdentityScreen';

export default function CreateIdentityRoute() {
  return <CreateIdentityScreen onContinue={() => router.replace('/feed')} />;
}
