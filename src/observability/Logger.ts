import { AppError } from '@/errors/AppError';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEvent {
  level: LogLevel;
  timestamp: number;
  scope: string;
  event: string;
  correlationId?: string;
  peerId?: string;
  transactionId?: string;
  durationMs?: number;
  errorCode?: string;
  message?: string;
  context?: Record<string, string | number | boolean | undefined>;
}

export interface LoggerSink {
  write(event: LogEvent): void;
}

export interface Logger {
  debug(event: string, context?: LogEvent['context']): void;
  info(event: string, context?: LogEvent['context']): void;
  warn(event: string, context?: LogEvent['context']): void;
  error(event: string, error: unknown, context?: LogEvent['context']): void;
}

class ConsoleLoggerSink implements LoggerSink {
  write(event: LogEvent): void {
    const prefix = `[${event.scope}] ${event.event}`;
    const payload = sanitizeLogEvent(event);

    switch (event.level) {
      case 'debug':
      case 'info':
        console.log(prefix, payload);
        break;
      case 'warn':
        console.warn(prefix, payload);
        break;
      case 'error':
        console.error(prefix, payload);
        break;
    }
  }
}

let globalSink: LoggerSink = new ConsoleLoggerSink();
let loggingEnabled = true;
let minimumLogLevel: LogLevel = getDefaultMinimumLogLevel();

export function setLoggerSink(sink: LoggerSink): void {
  globalSink = sink;
}

export function setLoggingEnabled(enabled: boolean): void {
  loggingEnabled = enabled;
}

export function setMinimumLogLevel(level: LogLevel): void {
  minimumLogLevel = level;
}

export function createLogger(scope: string): Logger {
  function emit(
    level: LogLevel,
    event: string,
    context?: LogEvent['context'],
    error?: unknown,
  ): void {
    if (!loggingEnabled || !shouldEmit(level)) {
      return;
    }

    const appError = error instanceof AppError ? error : undefined;
    globalSink.write({
      level,
      timestamp: Date.now(),
      scope,
      event,
      errorCode: appError?.code,
      message: error instanceof Error ? error.message : undefined,
      context: sanitizeContext(context),
    });
  }

  return {
    debug: (event, context) => emit('debug', event, context),
    info: (event, context) => emit('info', event, context),
    warn: (event, context) => emit('warn', event, context),
    error: (event, error, context) => emit('error', event, context, error),
  };
}

function shouldEmit(level: LogLevel): boolean {
  return getLogLevelPriority(level) >= getLogLevelPriority(minimumLogLevel);
}

function getLogLevelPriority(level: LogLevel): number {
  switch (level) {
    case 'debug':
      return 10;
    case 'info':
      return 20;
    case 'warn':
      return 30;
    case 'error':
      return 40;
  }
}

function getDefaultMinimumLogLevel(): LogLevel {
  const configured = getConfiguredLogLevel();
  return configured ?? 'warn';
}

function getConfiguredLogLevel(): LogLevel | null {
  const globalScope = globalThis as {
    __SYNPEER_LOG_LEVEL__?: unknown;
    __INSTA99_LOG_LEVEL__?: unknown;
    localStorage?: { getItem(key: string): string | null };
  };
  const value =
    typeof globalScope.__SYNPEER_LOG_LEVEL__ === 'string'
      ? globalScope.__SYNPEER_LOG_LEVEL__
      : typeof globalScope.__INSTA99_LOG_LEVEL__ === 'string'
        ? globalScope.__INSTA99_LOG_LEVEL__
        : (globalScope.localStorage?.getItem('synpeer:logLevel') ??
          globalScope.localStorage?.getItem('insta99:logLevel'));
  return isLogLevel(value) ? value : null;
}

function isLogLevel(value: unknown): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

function sanitizeLogEvent(event: LogEvent): Omit<LogEvent, 'timestamp'> & { timestamp: string } {
  return {
    ...event,
    timestamp: new Date(event.timestamp).toISOString(),
    context: event.context,
  };
}

function sanitizeContext(context: LogEvent['context']): LogEvent['context'] {
  if (!context) {
    return undefined;
  }

  const sanitized: LogEvent['context'] = {};
  for (const [key, value] of Object.entries(context)) {
    if (/private|secret|backup|seed|key/i.test(key)) {
      sanitized[key] = '[redacted]';
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
