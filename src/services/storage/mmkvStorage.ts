import { createMMKV } from 'react-native-mmkv';

import { createStorageService, type StorageDriver } from './StorageService';

const storage = createMMKV({
  id: 'synpeer.local',
});
const legacyStorage = createMMKV({
  id: 'insta99.local',
});

export function createMMKVStorageDriver(): StorageDriver {
  return {
    getString: (key) => {
      const current = storage.getString(key);
      if (current !== undefined) {
        return current;
      }
      const legacy = legacyStorage.getString(key);
      if (legacy !== undefined) {
        storage.set(key, legacy);
      }
      return legacy ?? null;
    },
    setString: (key, value) => {
      storage.set(key, value);
    },
    remove: (key) => {
      storage.remove(key);
      legacyStorage.remove(key);
    },
    clear: () => {
      storage.clearAll();
      legacyStorage.clearAll();
    },
  };
}

export const localStorageService = createStorageService(createMMKVStorageDriver());
