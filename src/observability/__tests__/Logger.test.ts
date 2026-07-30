import { AppError } from '@/errors/AppError';
import { createLogger, setLoggerSink, setMinimumLogLevel, type LogEvent } from '../Logger';

describe('Logger', () => {
  beforeEach(() => {
    setMinimumLogLevel('warn');
  });

  it('emits structured logs and redacts sensitive context keys', () => {
    const events: LogEvent[] = [];
    setLoggerSink({
      write: (event) => {
        events.push(event);
      },
    });

    const logger = createLogger('TestScope');
    logger.error(
      'failed',
      new AppError({
        code: 'IDENTITY_ERROR',
        message: 'private key leaked',
        safeMessage: 'Identity failed.',
      }),
      {
        privateKey: 'secret',
        peerId: 'peer-a',
      },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: 'error',
      scope: 'TestScope',
      event: 'failed',
      errorCode: 'IDENTITY_ERROR',
      context: {
        privateKey: '[redacted]',
        peerId: 'peer-a',
      },
    });
  });

  it('filters info logs by default and can be switched to verbose logging', () => {
    const events: LogEvent[] = [];
    setLoggerSink({
      write: (event) => {
        events.push(event);
      },
    });

    const logger = createLogger('TestScope');
    logger.info('boot_started');
    logger.warn('boot_degraded');

    expect(events.map((event) => event.event)).toEqual(['boot_degraded']);

    setMinimumLogLevel('info');
    logger.info('boot_started');

    expect(events.map((event) => event.event)).toEqual(['boot_degraded', 'boot_started']);
  });
});
