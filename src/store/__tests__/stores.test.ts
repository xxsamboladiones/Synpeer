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
  it('exports empty typed stores with stable initial state', () => {
    expect(useAuthStore.getState()).toEqual(authInitialState);
    expect(useProfileStore.getState()).toEqual(profileInitialState);
    expect(useWalletStore.getState()).toEqual(walletInitialState);
    expect(useSettingsStore.getState()).toEqual(settingsInitialState);
    expect(useNetworkStore.getState()).toEqual(networkInitialState);
    expect(useContributionStore.getState()).toEqual(contributionInitialState);
  });

  it('keeps phase 1 stores free of domain data', () => {
    const stores = [
      useAuthStore,
      useProfileStore,
      useWalletStore,
      useSettingsStore,
      useNetworkStore,
      useContributionStore,
    ];

    for (const store of stores) {
      expect(Object.keys(store.getState())).toHaveLength(0);
    }
  });
});
