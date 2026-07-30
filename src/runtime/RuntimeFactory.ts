import { createLogger, type Logger } from '@/observability/Logger';

import { ApplicationRuntime, type RuntimeConfig } from './ApplicationRuntime';

export type RuntimePlatform = 'web' | 'native' | 'test' | 'development';

export interface RuntimeFactoryOptions {
  platform?: RuntimePlatform;
  config?: RuntimeConfig;
  logger?: Logger;
  isolated?: boolean;
}

export interface RuntimeFactory {
  create(options?: RuntimeFactoryOptions): ApplicationRuntime;
}

export class DefaultRuntimeFactory implements RuntimeFactory {
  private readonly logger = createLogger('runtime.factory');

  create(options: RuntimeFactoryOptions = {}): ApplicationRuntime {
    this.logger.info('runtime_create_requested', {
      platform: options.platform ?? 'development',
      injectedLogger: Boolean(options.logger),
    });

    return options.isolated
      ? ApplicationRuntime.create(options.config)
      : ApplicationRuntime.getInstance(options.config);
  }
}

export const runtimeFactory: RuntimeFactory = new DefaultRuntimeFactory();
