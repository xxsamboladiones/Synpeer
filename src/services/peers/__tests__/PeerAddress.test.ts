import {
  getAutoDialPeerAddresses,
  isAutoDialPeerAddress,
  isManualWebRtcAddress,
  isWebRtcSignalAddress,
} from '../PeerAddress';

describe('PeerAddress', () => {
  it('separates auto-dial addresses from manual WebRTC signaling values', () => {
    expect(isManualWebRtcAddress('webrtc:manual-signaling')).toBe(true);
    expect(isWebRtcSignalAddress('synpeer:signal?data=abc')).toBe(true);
    expect(isWebRtcSignalAddress('synpeer://signal?data=abc')).toBe(true);
    expect(isWebRtcSignalAddress('insta99:signal?data=abc')).toBe(true);
    expect(isWebRtcSignalAddress('insta99://signal?data=abc')).toBe(true);
    expect(isAutoDialPeerAddress('/ip4/127.0.0.1/tcp/4001/p2p/peer-a')).toBe(true);
    expect(isAutoDialPeerAddress('webrtc:manual-signaling')).toBe(false);
    expect(isAutoDialPeerAddress('synpeer:signal?data=abc')).toBe(false);
    expect(
      getAutoDialPeerAddresses([
        'webrtc:manual-signaling',
        ' /ip4/127.0.0.1/tcp/4001/p2p/peer-a ',
        'synpeer:signal?data=abc',
        'insta99:signal?data=legacy',
      ]),
    ).toEqual(['/ip4/127.0.0.1/tcp/4001/p2p/peer-a']);
  });
});
