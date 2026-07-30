import { ensureLocalProfile } from '../identityProfile';
import type { ProfileData } from '@/models/Profile';

function makeProfile(overrides: Partial<ProfileData> = {}): ProfileData {
  return {
    id: 'profile_local-peer',
    author: 'local-peer',
    createdAt: 1,
    updatedAt: 1,
    signature: 'signature',
    version: '1.0.0',
    username: 'local_user',
    displayName: 'Local User',
    postCount: 0,
    followerCount: 0,
    followingCount: 0,
    ...overrides,
  };
}

describe('ensureLocalProfile', () => {
  it('reuses an existing local profile instead of creating it again', async () => {
    const existingProfile = makeProfile();
    const profiles = {
      getProfileByAuthor: jest.fn().mockResolvedValue(existingProfile),
      createProfile: jest.fn(),
    };

    await expect(ensureLocalProfile(profiles, 'local-peer', 'Local User')).resolves.toEqual(
      existingProfile,
    );

    expect(profiles.createProfile).not.toHaveBeenCalled();
  });

  it('creates a profile when the identity has no persisted profile yet', async () => {
    const createdProfile = makeProfile({
      username: 'local_user',
      displayName: 'Local User',
    });
    const profiles = {
      getProfileByAuthor: jest.fn().mockResolvedValue(null),
      createProfile: jest.fn().mockResolvedValue({ success: true, profile: createdProfile }),
    };

    await expect(ensureLocalProfile(profiles, 'local-peer', 'Local User')).resolves.toEqual(
      createdProfile,
    );

    expect(profiles.createProfile).toHaveBeenCalledWith('local-peer', 'local_user', 'Local User');
  });
});
