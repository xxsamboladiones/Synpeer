import { navigationRoutes } from '../../../navigation/routes';

describe('navigation routes', () => {
  it('defines the phase 1 visual flow', () => {
    expect(navigationRoutes.flow).toEqual(['/', '/identity/create', '/feed']);
    expect(navigationRoutes.homeDestinations).toEqual(['/chat', '/profile', '/settings']);
  });
});
