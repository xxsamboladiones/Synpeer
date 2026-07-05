import { createEmptyStore, emptyStoreInitialState } from './createEmptyStore';

export type ContributionStoreState = typeof emptyStoreInitialState;

export const contributionInitialState: ContributionStoreState = emptyStoreInitialState;
export const useContributionStore = createEmptyStore();
