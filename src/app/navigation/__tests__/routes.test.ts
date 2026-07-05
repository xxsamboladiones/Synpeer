import { navigationRoutes } from '../routes';

describe('navigation routes', () => {
  it('defines the phase 1 visual flow', () => {
    expect(navigationRoutes.flow).toEqual(['/', '/onboarding', '/identity/create', '/home']);
    expect(navigationRoutes.homeDestinations).toEqual(['/profile', '/settings']);
  });
});
