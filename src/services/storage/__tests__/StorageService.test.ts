import { createStorageService, type StorageDriver } from '../StorageService';

function createMemoryDriver(): StorageDriver {
  const data = new Map<string, string>();

  return {
    getString: (key) => data.get(key) ?? null,
    setString: (key, value) => {
      data.set(key, value);
    },
    remove: (key) => {
      data.delete(key);
    },
    clear: () => {
      data.clear();
    },
  };
}

describe('StorageService', () => {
  it('stores, reads, removes and clears string values', () => {
    const storage = createStorageService(createMemoryDriver());

    expect(storage.getString('missing')).toBeNull();

    storage.setString('session', 'local');

    expect(storage.getString('session')).toBe('local');

    storage.remove('session');

    expect(storage.getString('session')).toBeNull();

    storage.setString('a', '1');
    storage.setString('b', '2');
    storage.clear();

    expect(storage.getString('a')).toBeNull();
    expect(storage.getString('b')).toBeNull();
  });

  it('stores and reads typed JSON values', () => {
    const storage = createStorageService(createMemoryDriver());

    storage.setJson('settings', { darkMode: true, density: 'comfortable' });

    expect(storage.getJson<{ darkMode: boolean; density: string }>('settings')).toEqual({
      darkMode: true,
      density: 'comfortable',
    });
  });

  it('returns null for missing or invalid JSON values', () => {
    const storage = createStorageService(createMemoryDriver());

    storage.setString('broken', '{');

    expect(storage.getJson('missing')).toBeNull();
    expect(storage.getJson('broken')).toBeNull();
  });
});
