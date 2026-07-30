import { AppError } from '@/errors/AppError';

export type RuntimeStatus = 'idle' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';

export interface RuntimeLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): RuntimeStatus;
}

export function assertRuntimeStatus(
  status: RuntimeStatus,
  allowed: readonly RuntimeStatus[],
  operation: string,
): void {
  if (allowed.includes(status)) {
    return;
  }

  throw new AppError({
    code: 'RUNTIME_ERROR',
    message: `Cannot ${operation} while runtime status is ${status}`,
    safeMessage: 'O app ainda nao esta pronto para executar esta operacao.',
    severity: 'warning',
    retryable: status === 'starting' || status === 'stopping',
    context: {
      scope: 'runtime.lifecycle',
      operation,
      status,
    },
  });
}
