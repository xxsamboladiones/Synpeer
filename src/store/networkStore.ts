import { createEmptyStore, emptyStoreInitialState } from './createEmptyStore';

export type NetworkStoreState = typeof emptyStoreInitialState;

export const networkInitialState: NetworkStoreState = emptyStoreInitialState;
export const useNetworkStore = createEmptyStore();
