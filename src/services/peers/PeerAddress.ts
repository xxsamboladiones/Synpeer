import { LEGACY_URI_SCHEME, URI_SCHEME } from '@/constants/Brand';

const MANUAL_WEBRTC_ADDRESS = 'webrtc:manual-signaling';

export function isManualWebRtcAddress(address: string): boolean {
  return address.trim() === MANUAL_WEBRTC_ADDRESS;
}

export function isWebRtcSignalAddress(address: string): boolean {
  const trimmed = address.trim();
  return [URI_SCHEME, LEGACY_URI_SCHEME].some(
    (scheme) =>
      trimmed.startsWith(`${scheme}:signal?data=`) ||
      trimmed.startsWith(`${scheme}://signal?data=`),
  );
}

export function isAutoDialPeerAddress(address: string): boolean {
  const trimmed = address.trim();
  return Boolean(trimmed) && !isManualWebRtcAddress(trimmed) && !isWebRtcSignalAddress(trimmed);
}

export function getAutoDialPeerAddresses(addresses: readonly string[]): string[] {
  return addresses.map((address) => address.trim()).filter(isAutoDialPeerAddress);
}
