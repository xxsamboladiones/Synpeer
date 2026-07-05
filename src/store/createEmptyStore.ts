import { create } from 'zustand';

export type EmptyStoreState = Record<string, never>;

export const emptyStoreInitialState: EmptyStoreState = {};

export function createEmptyStore() {
  return create<EmptyStoreState>(() => emptyStoreInitialState);
}
