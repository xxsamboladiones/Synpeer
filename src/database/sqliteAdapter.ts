import * as SQLite from 'expo-sqlite';

import { createDatabaseService, DATABASE_NAME, type DatabaseService } from './DatabaseService';

export async function openDatabaseService(databaseName = DATABASE_NAME): Promise<DatabaseService> {
  const database = await SQLite.openDatabaseAsync(databaseName);

  return createDatabaseService({
    execAsync: (statement) => database.execAsync(statement),
    runAsync: (statement, params) => database.runAsync(statement, [...params]),
    withTransactionAsync: (work) => database.withTransactionAsync(work),
  });
}
