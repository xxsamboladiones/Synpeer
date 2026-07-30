import type { ProfileData } from '@/models/Profile';

export type LocalProfileService = {
  getProfileByAuthor(author: string): Promise<ProfileData | null>;
  createProfile(
    author: string,
    username: string,
    displayName: string,
  ): Promise<{ success: boolean; profile?: ProfileData; error?: string }>;
};

export async function ensureLocalProfile(
  profiles: LocalProfileService,
  identity: string,
  displayName: string,
): Promise<ProfileData> {
  const existingProfile = await profiles.getProfileByAuthor(identity);
  if (existingProfile) {
    return existingProfile;
  }

  const username = normalizeUsername(displayName, identity);
  const result = await profiles.createProfile(identity, username, displayName);
  if (!result.success || !result.profile) {
    throw new Error(result.error ?? 'Nao foi possivel criar o perfil');
  }
  return result.profile;
}

function normalizeUsername(displayName: string, identity: string): string {
  return (
    displayName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 30) || `user_${identity.slice(0, 8)}`
  );
}
