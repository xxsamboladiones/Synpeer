import { createDatabaseService, type SQLDatabase } from '../DatabaseService';

describe('DatabaseService', () => {
  it('wraps query and transaction execution behind a small interface', async () => {
    const calls: Array<{ statement: string; params: readonly unknown[] }> = [];
    const nativeDatabase: SQLDatabase = {
      execAsync: async (statement) => {
        calls.push({ statement, params: [] });
      },
      runAsync: async (statement, params) => {
        calls.push({ statement, params });
      },
      withTransactionAsync: async (work) => {
        calls.push({ statement: 'BEGIN', params: [] });
        await work();
        calls.push({ statement: 'COMMIT', params: [] });
      },
    };
    const database = createDatabaseService(nativeDatabase);

    await database.execute('CREATE TABLE migrations (version INTEGER)');
    await database.run('INSERT INTO migrations VALUES (?)', [1]);
    await database.transaction(async (tx) => {
      await tx.execute('SELECT 1');
    });

    expect(calls).toEqual([
      { statement: 'CREATE TABLE migrations (version INTEGER)', params: [] },
      { statement: 'INSERT INTO migrations VALUES (?)', params: [1] },
      { statement: 'BEGIN', params: [] },
      { statement: 'SELECT 1', params: [] },
      { statement: 'COMMIT', params: [] },
    ]);
  });
});
