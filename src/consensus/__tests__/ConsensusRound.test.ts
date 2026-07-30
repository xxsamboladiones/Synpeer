import { ConsensusEvents } from '../ConsensusEvents';
import { ConsensusRound } from '../ConsensusRound';
import { EvidenceManager } from '../EvidenceManager';
import { PeerVerification } from '../PeerVerification';
import { QuorumManager } from '../QuorumManager';
import { VoteManager } from '../VoteManager';
import { WitnessManager } from '../WitnessManager';

describe('ConsensusRound', () => {
  it('does not schedule real timers when started', () => {
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    const round = new ConsensusRound(
      'round-1',
      'contribution-1',
      'peer-a',
      'STORAGE',
      1,
      new ConsensusEvents(),
      new EvidenceManager(),
      new WitnessManager(),
      new VoteManager(),
      new QuorumManager(),
      new PeerVerification(),
    );

    round.start();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });
});
