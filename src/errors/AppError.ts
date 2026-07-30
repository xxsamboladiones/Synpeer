export type AppErrorSeverity = 'debug' | 'info' | 'warning' | 'error' | 'critical';

export type AppErrorCode =
  | 'VALIDATION_ERROR'
  | 'STORAGE_ERROR'
  | 'NETWORK_ERROR'
  | 'IDENTITY_ERROR'
  | 'TRANSACTION_ERROR'
  | 'CONSENSUS_ERROR'
  | 'TRUST_ERROR'
  | 'CONTRIBUTION_ERROR'
  | 'MEDIA_ERROR'
  | 'RUNTIME_ERROR'
  | 'UNSUPPORTED_CAPABILITY';

export interface AppErrorContext {
  scope?: string;
  operation?: string;
  peerId?: string;
  transactionId?: string;
  correlationId?: string;
  retryable?: boolean;
  [key: string]: string | number | boolean | undefined;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly safeMessage: string;
  readonly severity: AppErrorSeverity;
  readonly retryable: boolean;
  readonly context: AppErrorContext;
  override readonly cause?: unknown;

  constructor(options: {
    code: AppErrorCode;
    message: string;
    safeMessage?: string;
    severity?: AppErrorSeverity;
    retryable?: boolean;
    context?: AppErrorContext;
    cause?: unknown;
  }) {
    super(options.message);
    this.name = 'AppError';
    this.code = options.code;
    this.safeMessage = options.safeMessage ?? 'Something went wrong.';
    this.severity = options.severity ?? 'error';
    this.retryable = options.retryable ?? false;
    this.context = options.context ?? {};
    this.cause = options.cause;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      safeMessage: this.safeMessage,
      severity: this.severity,
      retryable: this.retryable,
      context: this.context,
    };
  }
}

export function toAppError(
  error: unknown,
  fallback: Omit<ConstructorParameters<typeof AppError>[0], 'cause'>,
): AppError {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError({
    ...fallback,
    message: error instanceof Error ? error.message : fallback.message,
    cause: error,
  });
}
