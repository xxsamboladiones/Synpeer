import * as SQLite from 'expo-sqlite';

import { createDatabaseService, DATABASE_NAME, type DatabaseService } from './DatabaseService';

export async function openDatabaseService(databaseName = DATABASE_NAME): Promise<DatabaseService> {
  const database = await SQLite.openDatabaseAsync(databaseName);

  return createDatabaseService({
    execAsync: (statement) => database.execAsync(statement),
    runAsync: (statement, params) => database.runAsync(statement, [...params]),
    getAllAsync: (statement, params = []) => database.getAllAsync(statement, [...params]),
    withTransactionAsync: async (work) => {
      let resolveResult: (value: Awaited<ReturnType<typeof work>>) => void = () => undefined;
      const result = new Promise<Awaited<ReturnType<typeof work>>>((resolve) => {
        resolveResult = resolve;
      });
      await database.withTransactionAsync(async () => {
        resolveResult(
          await work({
            execAsync: (statement) => database.execAsync(statement),
            runAsync: (statement, params) => database.runAsync(statement, [...params]),
            getAllAsync: (statement, params = []) => database.getAllAsync(statement, [...params]),
          }),
        );
      });
      return await result;
    },
  });
}
