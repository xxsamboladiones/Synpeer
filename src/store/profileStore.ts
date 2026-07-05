import { createEmptyStore, emptyStoreInitialState } from './createEmptyStore';

export type ProfileStoreState = typeof emptyStoreInitialState;

export const profileInitialState: ProfileStoreState = emptyStoreInitialState;
export const useProfileStore = createEmptyStore();
