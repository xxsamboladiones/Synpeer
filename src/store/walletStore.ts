import { createEmptyStore, emptyStoreInitialState } from './createEmptyStore';

export type WalletStoreState = typeof emptyStoreInitialState;

export const walletInitialState: WalletStoreState = emptyStoreInitialState;
export const useWalletStore = createEmptyStore();
