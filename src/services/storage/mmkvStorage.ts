import { createMMKV } from 'react-native-mmkv';

import { createStorageService, type StorageDriver } from './StorageService';

const storage = createMMKV({
  id: 'insta99.local',
});

export function createMMKVStorageDriver(): StorageDriver {
  return {
    getString: (key) => storage.getString(key) ?? null,
    setString: (key, value) => {
      storage.set(key, value);
    },
    remove: (key) => {
      storage.remove(key);
    },
    clear: () => {
      storage.clearAll();
    },
  };
}

export const localStorageService = createStorageService(createMMKVStorageDriver());
