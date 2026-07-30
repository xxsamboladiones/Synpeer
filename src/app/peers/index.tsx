import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Clipboard,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { useApplicationEvents } from '@/hooks/useApplicationEvents';
import { createLogger } from '@/observability/Logger';
import { appService } from '@/services/AppService';
import { getAutoDialPeerAddresses } from '@/services/peers/PeerAddress';
import type { WebRtcAutoSignalingStatus } from '@/network/WebRtcAutoSignaling';
import type { SynpeerPrivateNetworkSnapshot } from '@/network/WebRtcAutoSignaling';
import type { TrustedPeer } from '@/services/peers/TrustedPeerTypes';

const logger = createLogger('PeersScreen');

export default function PeersScreen() {
  const [peers, setPeers] = useState<TrustedPeer[]>([]);
  const [connectedPeers, setConnectedPeers] = useState<Set<string>>(new Set());
  const [peerRuntimeStates, setPeerRuntimeStates] = useState<Record<string, string>>({});
  const [canConnectPeers, setCanConnectPeers] = useState(false);
  const [canAutoSignal, setCanAutoSignal] = useState(false);
  const [signalingStatus, setSignalingStatus] = useState<WebRtcAutoSignalingStatus | null>(null);
  const [webRtcSessionCount, setWebRtcSessionCount] = useState(0);
  const [connectingPeerId, setConnectingPeerId] = useState<string | null>(null);
  const [peerOffers, setPeerOffers] = useState<Record<string, string>>({});
  const [peerErrors, setPeerErrors] = useState<Record<string, string>>({});
  const [peerMessages, setPeerMessages] = useState<Record<string, string>>({});
  const [privateNetwork, setPrivateNetwork] = useState<SynpeerPrivateNetworkSnapshot | null>(null);
  const [localPeerId, setLocalPeerId] = useState<string | null>(null);
  const [networkName, setNetworkName] = useState('Synpeer Network');
  const [signalingUrl, setSignalingUrl] = useState('');
  const [networkInvite, setNetworkInvite] = useState('');
  const [networkBusy, setNetworkBusy] = useState(false);

  const refresh = useCallback(async () => {
    await appService.initialize();
    const networkService = appService.getNetworkService();
    const health = appService.getRuntimeHealth();
    setLocalPeerId(health.localPeerId ?? null);
    setPeers(appService.getTrustedPeerRepository().list());
    setConnectedPeers(new Set(networkService.getConnectedPeers()));
    const runtimeSessions =
      (
        networkService as typeof networkService & {
          getPeerRuntimeSessions?: () => Array<{ peerId: string; status: string }>;
        }
      ).getPeerRuntimeSessions?.() ?? [];
    setPeerRuntimeStates(
      Object.fromEntries(runtimeSessions.map((session) => [session.peerId, session.status])),
    );
    setCanConnectPeers(health.network.canDialManualPeer);
    setCanAutoSignal(networkService.canAutoConnectToPeer());
    setWebRtcSessionCount(appService.getWebRtcSessions().length);
    const nextSignalingStatus = appService.getWebRtcSignalingStatus();
    setSignalingStatus(nextSignalingStatus);
    setSignalingUrl((current) => current || getSignalingUrl(nextSignalingStatus) || '');
    const snapshot = appService.getPrivateNetworkSnapshot();
    setPrivateNetwork(snapshot);
    if (snapshot) {
      const repository = appService.getTrustedPeerRepository();
      for (const member of snapshot.members) {
        if (
          member.peerId !== health.localPeerId &&
          member.status === 'approved' &&
          !repository.isRemoved(member.peerId) &&
          !repository.get(member.peerId)
        ) {
          repository.upsert({
            peerId: member.peerId,
            trustStatus: 'verified',
            source: 'discovery',
          });
        }
      }
      setPeers(appService.getTrustedPeerRepository().list());
    }
  }, []);

  useEffect(() => {
    const initialRefresh = globalThis.setTimeout(() => {
      void refresh();
    }, 0);
    return () => {
      globalThis.clearTimeout(initialRefresh);
    };
  }, [refresh]);
  useApplicationEvents(['peers'], refresh, { coalesceMs: 50 });

  const connectPeer = useCallback(
    async (peer: TrustedPeer) => {
      if (peer.trustStatus === 'blocked') {
        Alert.alert('Peer blocked', 'Unblock this peer before connecting.');
        return;
      }

      if (!canConnectPeers) {
        Alert.alert(
          'P2P dial unavailable',
          'Manual peer connection is not available in the current web runtime.',
        );
        return;
      }

      const dialableAddresses = getAutoDialPeerAddresses(peer.addresses);
      const canAutoDial = appService.getNetworkService().canAutoReconnectToPeerAddress();

      if (!canAutoDial || dialableAddresses.length === 0) {
        setConnectingPeerId(peer.peerId);
        setPeerErrors((current) => ({ ...current, [peer.peerId]: '' }));
        setPeerMessages((current) => ({ ...current, [peer.peerId]: '' }));
        try {
          const result = await appService.connectPeer(peer.peerId);
          if (result.code) {
            Clipboard.setString(result.code);
            setPeerOffers((current) => ({ ...current, [peer.peerId]: result.code ?? '' }));
            setPeerMessages((current) => ({
              ...current,
              [peer.peerId]:
                'Auto connection is not available here. The fallback connection code was copied.',
            }));
            Alert.alert(
              'Connection code copied',
              'Send this code to the peer. The other device can paste it in Network and send the response code back.',
            );
          } else {
            setPeerOffers((current) => {
              const next = { ...current };
              delete next[peer.peerId];
              return next;
            });
            setPeerMessages((current) => ({
              ...current,
              [peer.peerId]:
                'Connection request sent automatically. Keep Synpeer open on both devices.',
            }));
            Alert.alert(
              'Connection request sent',
              'The other app can answer automatically while both peers are open.',
            );
          }
          await refresh();
        } catch (error) {
          if (isPeerConnectionLimitError(error)) {
            await appService.getNetworkService().resetPeerConnections('peer-connect-limit');
            logger.warn('peer_connect_peer_connection_limit_recovered', {
              peerId: peer.peerId,
              message: error instanceof Error ? error.message : 'unknown',
            });
            setPeerErrors((current) => ({ ...current, [peer.peerId]: '' }));
            setPeerMessages((current) => ({
              ...current,
              [peer.peerId]:
                'WebRTC was saturated and local P2P sessions were reset. Try Connect again. If this browser was already saturated before the fix, reload this tab once.',
            }));
            await refresh();
            return;
          }
          logger.warn('peer_connect_failed', {
            peerId: peer.peerId,
            message: error instanceof Error ? error.message : 'unknown',
          });
          setPeerErrors((current) => ({
            ...current,
            [peer.peerId]:
              error instanceof Error ? error.message : 'Unable to start the P2P connection.',
          }));
        } finally {
          setConnectingPeerId(null);
        }
        return;
      }

      for (const address of dialableAddresses) {
        try {
          await appService.getNetworkService().connectToPeerAddress(address);
          if (appService.getTrustedPeerRepository().get(peer.peerId)?.trustStatus === 'verified') {
            await appService.getTrustedPeerSyncService().syncPeer(peer.peerId);
          }
          await refresh();
          Alert.alert('Peer connected', 'Handshake and sync run through the active P2P protocol.');
          return;
        } catch (error) {
          logger.warn('auto_dial_address_failed', {
            peerId: peer.peerId,
            address,
            message: error instanceof Error ? error.message : 'Unknown connection failure',
          });
        }
      }

      Alert.alert('Connection failed', 'None of the saved addresses could be reached.');
    },
    [canConnectPeers, refresh],
  );

  const blockPeer = useCallback(
    (peer: TrustedPeer) => {
      if (peer.trustStatus === 'blocked') {
        appService.getTrustedPeerRepository().markUnknown(peer.peerId);
      } else {
        appService.getTrustedPeerRepository().markBlocked(peer.peerId);
      }
      void refresh();
    },
    [refresh],
  );

  const removePeer = useCallback(
    async (peer: TrustedPeer) => {
      try {
        await appService.getNetworkService().disconnectPeer(peer.peerId);
      } catch (error) {
        logger.warn('peer_disconnect_before_remove_failed', {
          peerId: peer.peerId,
          message: error instanceof Error ? error.message : 'unknown',
        });
      }
      appService.getTrustedPeerRepository().remove(peer.peerId);
      setConnectedPeers((current) => {
        const next = new Set(current);
        next.delete(peer.peerId);
        return next;
      });
      setPeerErrors((current) => omitPeerState(current, peer.peerId));
      setPeerMessages((current) => omitPeerState(current, peer.peerId));
      setPeerOffers((current) => omitPeerState(current, peer.peerId));
      setPeers(appService.getTrustedPeerRepository().list());
      await refresh();
    },
    [refresh],
  );

  const copyInvite = useCallback((peer: TrustedPeer) => {
    const params: Array<[string, string]> = [];
    params.push(['v', '1']);
    params.push(['peerId', peer.peerId]);
    if (peer.identityId) {
      params.push(['identityId', peer.identityId]);
    }
    params.push(['createdAt', String(Date.now())]);
    for (const address of peer.addresses) {
      params.push(['addr', address]);
    }
    const query = params
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');
    Clipboard.setString(`synpeer:peer?${query}`);
    Alert.alert('Peer invite copied', 'Saved peer invite copied to clipboard.');
  }, []);

  const retrySignaling = useCallback(async () => {
    appService.retryWebRtcSignaling();
    await refresh();
  }, [refresh]);

  const createPrivateNetwork = useCallback(async () => {
    setNetworkBusy(true);
    try {
      const invite = await appService.createPrivateNetwork(
        networkName,
        signalingUrl.trim() || undefined,
      );
      Clipboard.setString(invite);
      setNetworkInvite(invite);
      await refresh();
      Alert.alert(
        'Private network created',
        'Invite copied. Send it to another device once. Both apps will use this signaling server.',
      );
    } catch (error) {
      logger.error('private_network_create_failed', error);
      Alert.alert(
        'Private network failed',
        error instanceof Error ? error.message : 'Unable to create private network.',
      );
    } finally {
      setNetworkBusy(false);
    }
  }, [networkName, refresh, signalingUrl]);

  const joinPrivateNetwork = useCallback(async () => {
    if (!networkInvite.trim()) {
      Alert.alert('Network invite required', 'Paste a synpeer:network invite first.');
      return;
    }
    setNetworkBusy(true);
    try {
      await appService.joinPrivateNetwork(networkInvite.trim());
      await refresh();
      Alert.alert('Join request sent', 'Keep both apps open. An approved member can approve you.');
    } catch (error) {
      logger.error('private_network_join_failed', error);
      Alert.alert(
        'Join failed',
        error instanceof Error ? error.message : 'Unable to join private network.',
      );
    } finally {
      setNetworkBusy(false);
    }
  }, [networkInvite, refresh]);

  const approvePrivateNetworkPeer = useCallback(
    async (peerId: string) => {
      setNetworkBusy(true);
      try {
        await appService.approvePrivateNetworkPeer(peerId);
        appService.getTrustedPeerRepository().forgetRemoved(peerId);
        appService.getTrustedPeerRepository().upsert({
          peerId,
          trustStatus: 'verified',
          source: 'discovery',
        });
        await refresh();
      } catch (error) {
        logger.error('private_network_approve_failed', error, { peerId });
        Alert.alert(
          'Approval failed',
          error instanceof Error ? error.message : 'Unable to approve this peer.',
        );
      } finally {
        setNetworkBusy(false);
      }
    },
    [refresh],
  );

  const addPrivateNetworkPeer = useCallback(
    async (peerId: string) => {
      const repository = appService.getTrustedPeerRepository();
      repository.forgetRemoved(peerId);
      repository.upsert({
        peerId,
        trustStatus: 'verified',
        source: 'discovery',
      });
      setPeerErrors((current) => omitPeerState(current, peerId));
      setPeerMessages((current) => ({
        ...current,
        [peerId]: 'Peer added. Use Connect to start the P2P session.',
      }));
      await refresh();
    },
    [refresh],
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Trusted Peers</Text>
      <Text style={styles.subtitle}>
        Known peers are persisted locally and reconnected when Synpeer starts.
      </Text>

      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.peerInfo}>
            <Text style={styles.peerName}>Automatic signaling</Text>
            <Text style={styles.peerId} testID="peer-signaling-status">
              {formatSignalingDescription(signalingStatus)}
            </Text>
          </View>
          <View style={[styles.badge, getSignalingBadgeStyle(signalingStatus)]}>
            <Text style={styles.badgeText}>{formatSignalingBadge(signalingStatus)}</Text>
          </View>
        </View>
        <Stat label="Retry" value={formatRetryState(signalingStatus)} />
        <Stat
          label="WebRTC sessions"
          value={webRtcSessionCount.toString()}
          testID="peer-webrtc-session-count"
        />
        {canRetrySignaling(signalingStatus) ? (
          <TouchableOpacity style={styles.secondaryButton} onPress={() => void retrySignaling()}>
            <Text style={styles.buttonText}>Retry signaling</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.peerInfo}>
            <Text style={styles.peerName}>Synpeer Private Network</Text>
            <Text style={styles.peerId}>
              {privateNetwork
                ? `${privateNetwork.name} - ${privateNetwork.members.length} member(s)`
                : 'Create or join a private coordination network'}
            </Text>
          </View>
          <View style={[styles.badge, privateNetwork ? styles.verified : styles.unknown]}>
            <Text style={styles.badgeText}>{privateNetwork ? 'joined' : 'none'}</Text>
          </View>
        </View>

        <TextInput
          style={styles.input}
          value={networkName}
          onChangeText={setNetworkName}
          placeholder="Network name"
          placeholderTextColor="#8E8E93"
        />
        <Text style={styles.helpText}>
          Use a signaling URL reachable by both computers, for example ws://192.168.1.10:8787.
        </Text>
        <TextInput
          style={styles.input}
          value={signalingUrl}
          onChangeText={setSignalingUrl}
          placeholder="Shared signaling URL"
          placeholderTextColor="#8E8E93"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity
          style={[styles.secondaryButton, networkBusy && styles.disabledButton]}
          onPress={() => void createPrivateNetwork()}
          disabled={networkBusy}
        >
          <Text style={styles.buttonText}>Create network and copy invite</Text>
        </TouchableOpacity>

        <TextInput
          style={[styles.input, styles.inviteInput]}
          value={networkInvite}
          onChangeText={setNetworkInvite}
          placeholder="Paste synpeer:network invite"
          placeholderTextColor="#8E8E93"
          multiline
        />
        <TouchableOpacity
          style={[styles.secondaryButton, networkBusy && styles.disabledButton]}
          onPress={() => void joinPrivateNetwork()}
          disabled={networkBusy}
        >
          <Text style={styles.buttonText}>Join network</Text>
        </TouchableOpacity>

        {privateNetwork ? (
          <View style={styles.memberList}>
            {privateNetwork.members.map((member) => (
              <View key={member.peerId} style={styles.memberRow}>
                <View style={styles.peerInfo}>
                  <Text style={styles.statLabel}>{shortPeerId(member.peerId)}</Text>
                  <Text style={styles.peerId}>
                    {member.status} - {member.online ? 'online' : 'offline'}
                  </Text>
                </View>
                {member.status === 'pending' ? (
                  <TouchableOpacity
                    style={[styles.button, networkBusy && styles.disabledButton]}
                    onPress={() => void approvePrivateNetworkPeer(member.peerId)}
                    disabled={networkBusy}
                  >
                    <Text style={styles.buttonText}>Approve</Text>
                  </TouchableOpacity>
                ) : member.status === 'approved' &&
                  member.peerId !== localPeerId &&
                  !peers.some((peer) => peer.peerId === member.peerId) ? (
                  <TouchableOpacity
                    style={[styles.button, networkBusy && styles.disabledButton]}
                    onPress={() => void addPrivateNetworkPeer(member.peerId)}
                    disabled={networkBusy}
                  >
                    <Text style={styles.buttonText}>Add peer</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {peers.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            No trusted peers yet. Import an invite from the Network screen.
          </Text>
        </View>
      ) : (
        peers.map((peer) => (
          <View key={peer.peerId} style={styles.card} testID={`peer-card-${peer.peerId}`}>
            <View style={styles.row}>
              <View style={styles.peerInfo}>
                <Text style={styles.peerName}>{peer.displayName ?? 'Peer'}</Text>
                <Text style={styles.peerId}>{peer.peerId}</Text>
              </View>
              <View style={[styles.badge, styles[peer.trustStatus]]}>
                <Text style={styles.badgeText}>{peer.trustStatus}</Text>
              </View>
            </View>

            <Stat
              label="Connection"
              testID={`peer-state-${peer.peerId}`}
              value={
                peerRuntimeStates[peer.peerId] ??
                (connectedPeers.has(peer.peerId) ? 'online' : 'offline')
              }
            />
            <Stat label="Addresses" value={peer.addresses.length.toString()} />
            <Stat
              label="Dialable addresses"
              value={getAutoDialPeerAddresses(peer.addresses).length.toString()}
            />
            <Stat
              label="Pairing"
              value={
                getAutoDialPeerAddresses(peer.addresses).length > 0
                  ? 'auto-dial'
                  : canAutoSignal
                    ? 'one-click when both apps are open'
                    : 'manual offer/answer'
              }
            />
            <Stat
              label="Last connection"
              value={
                peer.lastConnectedAt ? new Date(peer.lastConnectedAt).toLocaleString() : 'never'
              }
            />
            <Stat label="Synced objects" value={peer.syncedObjects.toString()} />

            <View style={styles.actions}>
              <TouchableOpacity
                testID={`peer-connect-${peer.peerId}`}
                style={[
                  styles.button,
                  (!canConnectPeers ||
                    peer.trustStatus === 'blocked' ||
                    connectingPeerId === peer.peerId) &&
                    styles.disabledButton,
                ]}
                onPress={() => void connectPeer(peer)}
                disabled={
                  !canConnectPeers ||
                  peer.trustStatus === 'blocked' ||
                  connectingPeerId === peer.peerId
                }
              >
                <Text style={styles.buttonText}>
                  {connectingPeerId === peer.peerId ? 'Connecting...' : 'Connect'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.button} onPress={() => copyInvite(peer)}>
                <Text style={styles.buttonText}>Copy</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.button} onPress={() => blockPeer(peer)}>
                <Text style={styles.buttonText}>
                  {peer.trustStatus === 'blocked' ? 'Unblock' : 'Block'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.button, styles.dangerButton]}
                onPress={() => removePeer(peer)}
              >
                <Text style={styles.buttonText}>Remove</Text>
              </TouchableOpacity>
            </View>

            {peerErrors[peer.peerId] ? (
              <Text style={styles.errorText}>{peerErrors[peer.peerId]}</Text>
            ) : null}

            {peerMessages[peer.peerId] ? (
              <Text style={styles.infoText}>{peerMessages[peer.peerId]}</Text>
            ) : null}

            {peerOffers[peer.peerId] ? (
              <View style={styles.offerPanel}>
                <Text style={styles.offerTitle}>Connection code ready</Text>
                <Text style={styles.offerHelp}>
                  Code copied. Send it to the other device, then paste the response code on this
                  browser in Network.
                </Text>
                <Text selectable style={styles.offerCode}>
                  {peerOffers[peer.peerId]}
                </Text>
                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={() => {
                    Clipboard.setString(peerOffers[peer.peerId]);
                    Alert.alert('Offer copied', 'WebRTC offer copied again.');
                  }}
                >
                  <Text style={styles.buttonText}>Copy code again</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        ))
      )}
    </ScrollView>
  );
}

function shortPeerId(peerId: string): string {
  return peerId.length > 18 ? `${peerId.slice(0, 8)}...${peerId.slice(-8)}` : peerId;
}

function omitPeerState(record: Record<string, string>, peerId: string): Record<string, string> {
  const next = { ...record };
  delete next[peerId];
  return next;
}

function isPeerConnectionLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes('cannot create so many peerconnections') ||
    message.includes('too many peerconnections') ||
    message.includes('peerconnection limit')
  );
}

function Stat({ label, value, testID }: { label: string; value: string; testID?: string }) {
  return (
    <View style={styles.statRow} testID={testID}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

function findWebSocketStatus(
  status: WebRtcAutoSignalingStatus | null,
): WebRtcAutoSignalingStatus | null {
  if (!status) {
    return null;
  }
  if (status.name === 'websocket') {
    return status;
  }
  return status.transports?.find((transport) => transport.name === 'websocket') ?? null;
}

function findSupabaseStatus(
  status: WebRtcAutoSignalingStatus | null,
): WebRtcAutoSignalingStatus | null {
  if (!status) {
    return null;
  }
  if (status.name === 'supabase') {
    return status;
  }
  return status.transports?.find((transport) => transport.name === 'supabase') ?? null;
}

function findRemoteSignalingStatus(
  status: WebRtcAutoSignalingStatus | null,
): WebRtcAutoSignalingStatus | null {
  const supabase = findSupabaseStatus(status);
  if (supabase?.state === 'connected') {
    return supabase;
  }
  return findWebSocketStatus(status) ?? supabase;
}

function getSignalingUrl(status: WebRtcAutoSignalingStatus | null): string {
  return findRemoteSignalingStatus(status)?.url ?? '';
}

function formatSignalingBadge(status: WebRtcAutoSignalingStatus | null): string {
  const remote = findRemoteSignalingStatus(status);
  if (remote?.state === 'connected') {
    return 'online';
  }
  if (remote?.state === 'reconnecting' || remote?.state === 'connecting') {
    return 'retrying';
  }
  if (status?.state === 'connected') {
    return 'local';
  }
  return 'offline';
}

function formatSignalingDescription(status: WebRtcAutoSignalingStatus | null): string {
  const supabase = findSupabaseStatus(status);
  if (supabase?.state === 'connected') {
    return supabase.url
      ? `Supabase Realtime connected: ${supabase.url}`
      : 'Supabase Realtime connected';
  }
  const websocket = findWebSocketStatus(status);
  if (websocket?.state === 'connected') {
    return websocket.url
      ? `Local signaling connected: ${websocket.url}`
      : 'Local signaling connected';
  }
  const remote = findRemoteSignalingStatus(status);
  if (remote?.state === 'reconnecting') {
    return 'Server disconnected. Synpeer is retrying automatically.';
  }
  if (status?.state === 'connected') {
    return 'Local browser fallback is active. Start the signaling server for devices.';
  }
  return 'Automatic peer connection is unavailable.';
}

function formatRetryState(status: WebRtcAutoSignalingStatus | null): string {
  const remote = findRemoteSignalingStatus(status);
  if (!remote || remote.state === 'connected') {
    return 'idle';
  }
  if (remote.retryDelayMs) {
    return `attempt ${remote.reconnectAttempt} in ${Math.ceil(remote.retryDelayMs / 1000)}s`;
  }
  return remote.reconnectAttempt > 0 ? `attempt ${remote.reconnectAttempt}` : 'idle';
}

function canRetrySignaling(status: WebRtcAutoSignalingStatus | null): boolean {
  const remote = findRemoteSignalingStatus(status);
  return Boolean(
    remote?.available &&
    (remote.state === 'idle' || remote.state === 'reconnecting' || remote.state === 'stopped'),
  );
}

function getSignalingBadgeStyle(status: WebRtcAutoSignalingStatus | null) {
  const badge = formatSignalingBadge(status);
  if (badge === 'online') {
    return styles.verified;
  }
  if (badge === 'retrying' || badge === 'local') {
    return styles.unknown;
  }
  return styles.blocked;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050509',
  },
  content: {
    gap: 16,
    padding: 16,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 30,
    fontWeight: '800',
  },
  subtitle: {
    color: '#8E8E93',
    fontSize: 14,
    lineHeight: 20,
  },
  card: {
    backgroundColor: '#0A0A0F',
    borderColor: '#1C1C1E',
    borderRadius: 8,
    borderWidth: 1,
    padding: 16,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    marginBottom: 12,
  },
  peerInfo: {
    flex: 1,
  },
  peerName: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
  },
  peerId: {
    color: '#8E8E93',
    fontSize: 12,
    marginTop: 4,
  },
  badge: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  unknown: {
    backgroundColor: 'rgba(255, 204, 0, 0.18)',
  },
  verified: {
    backgroundColor: 'rgba(52, 199, 89, 0.18)',
  },
  blocked: {
    backgroundColor: 'rgba(255, 59, 48, 0.18)',
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  statRow: {
    borderTopColor: '#1C1C1E',
    borderTopWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  statLabel: {
    color: '#FFFFFF',
    flex: 1,
    fontSize: 14,
  },
  statValue: {
    color: '#8E8E93',
    flex: 1,
    fontSize: 14,
    textAlign: 'right',
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  button: {
    backgroundColor: '#0A84FF',
    borderRadius: 8,
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  disabledButton: {
    opacity: 0.55,
  },
  dangerButton: {
    backgroundColor: '#FF453A',
  },
  secondaryButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#0A84FF',
    borderRadius: 8,
    justifyContent: 'center',
    marginTop: 10,
    minHeight: 38,
    paddingHorizontal: 12,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  errorText: {
    color: '#FF453A',
    fontSize: 13,
    lineHeight: 18,
    marginTop: 12,
  },
  infoText: {
    color: '#C7C7CC',
    fontSize: 13,
    lineHeight: 18,
    marginTop: 12,
  },
  offerPanel: {
    backgroundColor: '#050509',
    borderColor: '#1C1C1E',
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 14,
    padding: 12,
  },
  offerTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  offerHelp: {
    color: '#8E8E93',
    fontSize: 13,
    lineHeight: 18,
    marginTop: 6,
  },
  offerCode: {
    color: '#C7C7CC',
    fontSize: 11,
    lineHeight: 16,
    marginTop: 10,
    maxHeight: 120,
  },
  emptyText: {
    color: '#8E8E93',
    fontSize: 14,
  },
  helpText: {
    color: '#8E8E93',
    fontSize: 12,
    lineHeight: 16,
    marginBottom: 8,
    marginTop: 12,
  },
  input: {
    backgroundColor: '#050509',
    borderColor: '#1C1C1E',
    borderRadius: 8,
    borderWidth: 1,
    color: '#FFFFFF',
    fontSize: 14,
    minHeight: 42,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  inviteInput: {
    marginTop: 12,
    minHeight: 78,
    textAlignVertical: 'top',
  },
  memberList: {
    borderTopColor: '#1C1C1E',
    borderTopWidth: 1,
    gap: 8,
    marginTop: 14,
    paddingTop: 12,
  },
  memberRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
  },
});
