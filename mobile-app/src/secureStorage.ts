import { SecureStorage } from '@aparajita/capacitor-secure-storage';

// The plugin prefix is process-global. Serialize prefix changes with the storage
// operation so remote gateway tokens and model API keys can never cross namespaces.
let storageQueue: Promise<void> = Promise.resolve();

function withPrefix<T>(prefix: string, operation: () => Promise<T>): Promise<T> {
  const result = storageQueue.then(async () => {
    await SecureStorage.setKeyPrefix(prefix);
    return operation();
  });

  storageQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function secureGet(prefix: string, key: string): Promise<string | null> {
  return withPrefix(prefix, async () => {
    const value = await SecureStorage.getItem(key);
    return value == null ? null : String(value);
  });
}

export function secureSet(prefix: string, key: string, value: string): Promise<void> {
  return withPrefix(prefix, async () => {
    await SecureStorage.setItem(key, value);
  });
}

export function secureRemove(prefix: string, key: string): Promise<void> {
  return withPrefix(prefix, async () => {
    await SecureStorage.removeItem(key);
  });
}
