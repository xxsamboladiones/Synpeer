import { createEmptyStore, emptyStoreInitialState } from './createEmptyStore';

export type AuthStoreState = typeof emptyStoreInitialState;

export const authInitialState: AuthStoreState = emptyStoreInitialState;
export const useAuthStore = createEmptyStore();
