import {
  authInitialState,
  contributionInitialState,
  networkInitialState,
  profileInitialState,
  settingsInitialState,
  useAuthStore,
  useContributionStore,
  useNetworkStore,
  useProfileStore,
  useSettingsStore,
  useWalletStore,
  walletInitialState,
} from '../index';

describe('global Zustand stores', () => {
  it('exports typed stores with stable initial state', () => {
    // AuthStore now has identityCreated for phase 1 identity flow
    const authState = useAuthStore.getState();
    expect(authState.identityCreated).toBe(authInitialState.identityCreated);
    expect(typeof authState.setIdentityCreated).toBe('function');

    expect(useProfileStore.getState()).toEqual(profileInitialState);
    expect(useWalletStore.getState()).toEqual(walletInitialState);
    expect(useSettingsStore.getState()).toEqual(settingsInitialState);
    expect(useNetworkStore.getState()).toEqual(networkInitialState);
    expect(useContributionStore.getState()).toEqual(contributionInitialState);
  });

  it('keeps most phase 1 stores free of domain data', () => {
    const stores = [
      useProfileStore,
      useWalletStore,
      useSettingsStore,
      useNetworkStore,
      useContributionStore,
    ];

    for (const store of stores) {
      expect(Object.keys(store.getState())).toHaveLength(0);
    }

    // AuthStore is expected to have identityCreated for phase 1
    expect(Object.keys(useAuthStore.getState()).length).toBeGreaterThan(0);
  });
});
