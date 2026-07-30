import { create } from 'zustand';

export type AuthStoreState = {
  identityCreated: boolean;
  setIdentityCreated: (created: boolean) => void;
};

export const authInitialState: Pick<AuthStoreState, 'identityCreated'> = {
  identityCreated: false,
};

export const useAuthStore = create<AuthStoreState>((set) => ({
  ...authInitialState,
  setIdentityCreated: (created) => set({ identityCreated: created }),
}));
