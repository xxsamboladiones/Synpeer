import type { DatabaseExecutor } from './migrations/MigrationRunner';

export const DATABASE_NAME = 'insta99.db';

export type SQLParameter = string | number | boolean | null | Uint8Array;

export type SQLDatabase = {
  execAsync: (statement: string) => Promise<void>;
  runAsync: (statement: string, params: readonly SQLParameter[]) => Promise<unknown>;
  withTransactionAsync: (work: () => Promise<void>) => Promise<void>;
};

export type DatabaseService = DatabaseExecutor & {
  run: (statement: string, params?: readonly SQLParameter[]) => Promise<void>;
};

export function createDatabaseService(database: SQLDatabase): DatabaseService {
  const service: DatabaseService = {
    execute: async (statement) => {
      await database.execAsync(statement);
    },
    run: async (statement, params = []) => {
      await database.runAsync(statement, params);
    },
    transaction: async (work) => {
      await database.withTransactionAsync(async () => {
        await work(service);
      });
    },
  };

  return service;
}
