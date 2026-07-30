export const navigationRoutes = {
  flow: ['/', '/identity/create', '/feed'],
  homeDestinations: ['/chat', '/profile', '/settings'],
} as const;

export type AppRoute =
  (typeof navigationRoutes.flow)[number] | (typeof navigationRoutes.homeDestinations)[number];
