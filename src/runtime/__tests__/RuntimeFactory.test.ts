jest.mock('../ApplicationRuntime', () => ({
  ApplicationRuntime: {
    create: jest.fn(() => ({ getStatus: () => 'idle' })),
    getInstance: jest.fn(() => ({ getStatus: () => 'idle' })),
  },
}));

import { DefaultRuntimeFactory } from '../RuntimeFactory';

describe('RuntimeFactory', () => {
  it('creates isolated runtimes for tests without sharing lifecycle state', () => {
    const factory = new DefaultRuntimeFactory();

    const first = factory.create({ platform: 'test', isolated: true });
    const second = factory.create({ platform: 'test', isolated: true });

    expect(first).not.toBe(second);
    expect(first.getStatus()).toBe('idle');
    expect(second.getStatus()).toBe('idle');
  });
});
