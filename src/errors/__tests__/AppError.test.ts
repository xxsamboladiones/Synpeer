import { AppError, toAppError } from '../AppError';

describe('AppError', () => {
  it('keeps technical and safe user-facing messages separate', () => {
    const error = new AppError({
      code: 'NETWORK_ERROR',
      message: 'dial failed for /ip4/private-address',
      safeMessage: 'Could not connect to peer.',
      retryable: true,
      context: { scope: 'network', peerId: 'peer-a' },
    });

    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.safeMessage).toBe('Could not connect to peer.');
    expect(error.retryable).toBe(true);
    expect(error.toJSON()).toMatchObject({
      code: 'NETWORK_ERROR',
      safeMessage: 'Could not connect to peer.',
      context: { scope: 'network', peerId: 'peer-a' },
    });
  });

  it('wraps unknown errors with a typed fallback', () => {
    const error = toAppError(new Error('broken'), {
      code: 'RUNTIME_ERROR',
      message: 'fallback',
      safeMessage: 'Runtime failed.',
    });

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('RUNTIME_ERROR');
    expect(error.message).toBe('broken');
  });
});
