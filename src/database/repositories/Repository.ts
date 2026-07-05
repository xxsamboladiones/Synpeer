import type { DatabaseExecutor } from '../migrations/MigrationRunner';

export abstract class Repository {
  protected constructor(protected readonly database: DatabaseExecutor) {}
}
