import { createEmptyStore, emptyStoreInitialState } from './createEmptyStore';

export type SettingsStoreState = typeof emptyStoreInitialState;

export const settingsInitialState: SettingsStoreState = emptyStoreInitialState;
export const useSettingsStore = createEmptyStore();
