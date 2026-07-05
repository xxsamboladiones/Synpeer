export const navigationRoutes = {
  flow: ['/', '/onboarding', '/identity/create', '/home'],
  homeDestinations: ['/profile', '/settings'],
} as const;

export type AppRoute =
  (typeof navigationRoutes.flow)[number] | (typeof navigationRoutes.homeDestinations)[number];
