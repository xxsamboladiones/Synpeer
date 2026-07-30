import type { RuntimeHealthSnapshot } from './RuntimeHealth';

export type ComponentHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface ComponentHealth {
  component: string;
  status: ComponentHealthStatus;
  message?: string;
  checkedAt: number;
  details?: Record<string, string | number | boolean | null | undefined>;
}

export interface HealthContributor {
  getHealth(): Promise<ComponentHealth> | ComponentHealth;
}

export interface RuntimeHealthService {
  getSnapshot(): Promise<RuntimeHealthSnapshot>;
  getComponents(): Promise<ComponentHealth[]>;
}

export class DefaultRuntimeHealthService implements RuntimeHealthService {
  constructor(
    private readonly snapshotCollector: () =>
      RuntimeHealthSnapshot | Promise<RuntimeHealthSnapshot>,
    private readonly contributors: readonly HealthContributor[] = [],
  ) {}

  async getSnapshot(): Promise<RuntimeHealthSnapshot> {
    return await this.snapshotCollector();
  }

  async getComponents(): Promise<ComponentHealth[]> {
    const components: ComponentHealth[] = [];

    for (const contributor of this.contributors) {
      try {
        components.push(redactComponentHealth(await contributor.getHealth()));
      } catch (error) {
        components.push({
          component: 'unknown',
          status: 'unhealthy',
          message: error instanceof Error ? error.message : 'Health contributor failed',
          checkedAt: Date.now(),
        });
      }
    }

    return components;
  }
}

function redactComponentHealth(health: ComponentHealth): ComponentHealth {
  if (!health.details) {
    return health;
  }

  const details: ComponentHealth['details'] = {};
  for (const [key, value] of Object.entries(health.details)) {
    details[key] = /private|secret|backup|seed|key/i.test(key) ? '[redacted]' : value;
  }

  return { ...health, details };
}
