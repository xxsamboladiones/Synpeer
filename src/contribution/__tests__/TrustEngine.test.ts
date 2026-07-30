import { createFixedClock } from '@/time/Clock';

import { TrustEngine } from '../TrustEngine';

describe('TrustEngine', () => {
  it('applies idempotent observations only once', () => {
    const engine = new TrustEngine(undefined, undefined, createFixedClock(1000));

    expect(
      engine.recordObservation({
        eventId: 'event-1',
        peerId: 'peer-a',
        type: 'success',
        responseTime: 50,
      }),
    ).toBe(true);
    expect(
      engine.recordObservation({
        eventId: 'event-1',
        peerId: 'peer-a',
        type: 'success',
        responseTime: 50,
      }),
    ).toBe(false);

    expect(engine.getTrustScore('peer-a').successfulResponses).toBe(1);
    expect(engine.getTrustScore('peer-a').score).toBe(510);
  });

  it('normalizes invalid availability inputs and clamps score', () => {
    const engine = new TrustEngine(
      undefined,
      { ...undefinedPolicy(), maxScore: 505 },
      createFixedClock(1000),
    );

    engine.updateAvailability('peer-a', Number.NaN);
    engine.recordSuccessfulResponse('peer-a', 1);

    expect(engine.getTrustScore('peer-a').availability).toBe(0);
    expect(engine.getTrustScore('peer-a').score).toBe(505);
  });
});

function undefinedPolicy() {
  return {
    minScore: 0,
    maxScore: 1000,
    successDelta: 10,
    failureDelta: -20,
    connectionDelta: 5,
    disconnectionDelta: -10,
    highAvailabilityDelta: 15,
    goodAvailabilityDelta: 10,
    lowAvailabilityDelta: -25,
  };
}
