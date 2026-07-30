export type DatabaseExecutor = {
  execute: (statement: string) => Promise<void>;
  transaction: <T>(work: (database: DatabaseExecutor) => Promise<T>) => Promise<T>;
};

export type Migration = {
  version: number;
  name: string;
  up: (database: DatabaseExecutor) => Promise<void>;
};

export type MigrationRunner = {
  run: (options: { currentVersion: number }) => Promise<void>;
};

type CreateMigrationRunnerOptions = {
  executor: DatabaseExecutor;
  migrations: readonly Migration[];
};

export function createMigrationRunner({
  executor,
  migrations,
}: CreateMigrationRunnerOptions): MigrationRunner {
  const orderedMigrations = [...migrations].sort((left, right) => left.version - right.version);

  return {
    run: async ({ currentVersion }) => {
      await executor.transaction(async (transaction) => {
        for (const migration of orderedMigrations) {
          if (migration.version > currentVersion) {
            await migration.up(transaction);
          }
        }
      });
    },
  };
}

export const initialMigrations: readonly Migration[] = [];
