export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export function createFixedClock(initialTime: number): Clock & { advance(ms: number): void } {
  let current = initialTime;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}
