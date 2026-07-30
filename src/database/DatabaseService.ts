import type { DatabaseExecutor } from './migrations/MigrationRunner';

// Keep the physical database name stable until native SQLite can migrate files atomically.
export const LEGACY_DATABASE_NAME = 'insta99.db';
export const DATABASE_NAME = LEGACY_DATABASE_NAME;

export type SQLParameter = string | number | boolean | null | Uint8Array;

export type SQLDatabaseOperations = {
  execAsync: (statement: string) => Promise<void>;
  runAsync: (statement: string, params: readonly SQLParameter[]) => Promise<unknown>;
  getAllAsync: (statement: string, params?: readonly SQLParameter[]) => Promise<readonly unknown[]>;
};

export type SQLDatabase = SQLDatabaseOperations & {
  withTransactionAsync: <T>(
    work: (transaction?: SQLDatabaseOperations) => Promise<T>,
  ) => Promise<T>;
  closeAsync?: () => Promise<void>;
  resetAsync?: () => Promise<void>;
  capabilities?: Record<string, string | number | boolean>;
};

export type DatabaseService = Omit<DatabaseExecutor, 'transaction'> & {
  run: (statement: string, params?: readonly SQLParameter[]) => Promise<void>;
  query: (statement: string, params?: readonly SQLParameter[]) => Promise<readonly unknown[]>;
  transaction: <T>(work: (database: DatabaseService) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
  reset: () => Promise<void>;
  getCapabilities: () => Record<string, string | number | boolean>;
};

export function createDatabaseService(database: SQLDatabase): DatabaseService {
  const createService = (
    operations: SQLDatabaseOperations,
    transaction: DatabaseService['transaction'],
  ): DatabaseService => ({
    execute: async (statement) => {
      await operations.execAsync(statement);
    },
    run: async (statement, params = []) => {
      await operations.runAsync(statement, params);
    },
    query: async (statement, params = []) => {
      return await operations.getAllAsync(statement, params);
    },
    transaction,
    close: async () => {
      await database.closeAsync?.();
    },
    reset: async () => {
      await database.resetAsync?.();
    },
    getCapabilities: () => database.capabilities ?? {},
  });

  let service: DatabaseService;
  const runTransaction: DatabaseService['transaction'] = async (work) =>
    await database.withTransactionAsync(async (transactionOperations) => {
      let transactionService: DatabaseService;
      const runNestedTransaction: DatabaseService['transaction'] = async (nestedWork) =>
        await nestedWork(transactionService);
      transactionService = createService(transactionOperations ?? database, runNestedTransaction);
      return await work(transactionService);
    });
  service = createService(database, runTransaction);
  return service;
}
