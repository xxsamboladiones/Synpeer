import { Repository } from '../repositories/Repository';
import type { DatabaseExecutor } from '../migrations/MigrationRunner';

class TestRepository extends Repository {
  constructor(database: DatabaseExecutor) {
    super(database);
  }

  async ping() {
    await this.database.execute('SELECT 1');
  }
}

describe('Repository', () => {
  it('keeps repositories dependent only on the database executor boundary', async () => {
    const calls: string[] = [];
    const executor: DatabaseExecutor = {
      execute: async (statement) => {
        calls.push(statement);
      },
      transaction: async (work) => work(executor),
    };
    const repository = new TestRepository(executor);

    await repository.ping();

    expect(calls).toEqual(['SELECT 1']);
  });
});
