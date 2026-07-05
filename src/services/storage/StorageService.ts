export type StorageDriver = {
  getString: (key: string) => string | null;
  setString: (key: string, value: string) => void;
  remove: (key: string) => void;
  clear: () => void;
};

export type StorageService = {
  getString: (key: string) => string | null;
  setString: (key: string, value: string) => void;
  getJson: <TValue>(key: string) => TValue | null;
  setJson: <TValue>(key: string, value: TValue) => void;
  remove: (key: string) => void;
  clear: () => void;
};

export function createStorageService(driver: StorageDriver): StorageService {
  return {
    getString: (key) => driver.getString(key),
    setString: (key, value) => {
      driver.setString(key, value);
    },
    getJson: (key) => {
      const value = driver.getString(key);

      if (!value) {
        return null;
      }

      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    },
    setJson: (key, value) => {
      driver.setString(key, JSON.stringify(value));
    },
    remove: (key) => {
      driver.remove(key);
    },
    clear: () => {
      driver.clear();
    },
  };
}
