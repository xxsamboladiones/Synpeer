import {
  createMigrationRunner,
  type DatabaseExecutor,
  type Migration,
} from '../migrations/MigrationRunner';

function createExecutor() {
  const calls: string[] = [];
  const executor: DatabaseExecutor = {
    execute: async (statement) => {
      calls.push(statement);
    },
    transaction: async (work) => {
      calls.push('BEGIN');
      const result = await work(executor);
      calls.push('COMMIT');
      return result;
    },
  };

  return { calls, executor };
}

describe('MigrationRunner', () => {
  it('runs pending migrations in version order inside a transaction', async () => {
    const { calls, executor } = createExecutor();
    const migrations: Migration[] = [
      {
        version: 2,
        name: 'second',
        up: async (db) => db.execute('SELECT 2'),
      },
      {
        version: 1,
        name: 'first',
        up: async (db) => db.execute('SELECT 1'),
      },
    ];

    const runner = createMigrationRunner({ executor, migrations });

    await runner.run({ currentVersion: 0 });

    expect(calls).toEqual(['BEGIN', 'SELECT 1', 'SELECT 2', 'COMMIT']);
  });

  it('skips migrations that already ran', async () => {
    const { calls, executor } = createExecutor();
    const runner = createMigrationRunner({
      executor,
      migrations: [
        {
          version: 1,
          name: 'first',
          up: async (db) => db.execute('SELECT 1'),
        },
      ],
    });

    await runner.run({ currentVersion: 1 });

    expect(calls).toEqual(['BEGIN', 'COMMIT']);
  });
});
