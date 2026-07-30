import React, { useCallback, useEffect, useState } from 'react';
import { router } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  Clipboard,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { createLogger } from '@/observability/Logger';
import { appService } from '@/services/AppService';
import { decodeWebRtcSignal } from '@/network/WebRtcSignaling';
import type { WebRtcSessionSnapshot } from '@/network/WebRtcPeerTransport';
import type { WebRtcAutoSignalingStatus } from '@/network/WebRtcAutoSignaling';
import type { StorageHealthSnapshot } from '@/runtime/StorageHealth';

type PeerRow = {
  id: string;
  connected: boolean;
  latency: number | null;
};

type NetworkStatus = {
  connectedPeers: number;
  totalPeers: number;
  latency: number | null;
  synchronization: number;
  packetRate: number;
  replicationQueue: number;
  connectionQuality: string;
  isOnline: boolean;
};

const emptyStatus: NetworkStatus = {
  connectedPeers: 0,
  totalPeers: 0,
  latency: null,
  synchronization: 0,
  packetRate: 0,
  replicationQueue: 0,
  connectionQuality: 'Unavailable',
  isOnline: false,
};

const logger = createLogger('NetworkStatusScreen');

export default function NetworkStatusScreen() {
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus>(emptyStatus);
  const [peers, setPeers] = useState<PeerRow[]>([]);
  const [localPeerId, setLocalPeerId] = useState('Not started');
  const [listenAddresses, setListenAddresses] = useState<string[]>([]);
  const [webRtcSessions, setWebRtcSessions] = useState<WebRtcSessionSnapshot[]>([]);
  const [signalingStatus, setSignalingStatus] = useState<WebRtcAutoSignalingStatus | null>(null);
  const [storageHealth, setStorageHealth] = useState<StorageHealthSnapshot | null>(null);
  const [inviteUri, setInviteUri] = useState('');
  const [connectionCode, setConnectionCode] = useState('');
  const [generatedCode, setGeneratedCode] = useState('');
  const [connectionStep, setConnectionStep] = useState('Create or paste a connection code.');
  const [trustedPeerCount, setTrustedPeerCount] = useState(0);
  const [canConnectPeers, setCanConnectPeers] = useState(false);
  const [hasLocalIdentity, setHasLocalIdentity] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [loading, setLoading] = useState(true);

  const refreshNetworkStatus = useCallback(async () => {
    try {
      await appService.initialize();
      const networkService = appService.getNetworkService();
      const health = await appService.getDetailedRuntimeHealth();
      const storageSnapshot = health.storage.details;
      const connectedPeers = networkService.getConnectedPeers();
      const discoveredPeers = networkService.getDiscoveredPeers();
      const addresses = networkService.getListenAddresses();
      const currentPeerId =
        networkService.getPeerManager().getPeerId() ?? appService.getLocalPeerId();
      const knownPeers = Array.from(new Set([...connectedPeers, ...discoveredPeers]));
      const pingProtocol = networkService.getPingProtocol();
      const peerRows = knownPeers.map((peerId) => ({
        id: peerId,
        connected: connectedPeers.includes(peerId),
        latency: connectedPeers.includes(peerId) ? pingProtocol.getAverageLatency(peerId) : null,
      }));
      const storageKeys = health.storage.totalKeys ?? storageSnapshot?.totalKeys ?? 0;
      const replicatedKeys = storageSnapshot?.replicatedKeys ?? 0;
      const pendingSync = health.sync.pending + health.sync.sending;

      setLocalPeerId(currentPeerId ?? 'Create an identity to enable P2P connections');
      setListenAddresses(addresses);
      setWebRtcSessions(appService.getWebRtcSessions());
      setSignalingStatus(appService.getWebRtcSignalingStatus());
      setStorageHealth(storageSnapshot ?? null);
      setHasLocalIdentity(Boolean(currentPeerId));
      setCanConnectPeers(Boolean(currentPeerId) && health.network.canDialManualPeer);
      setTrustedPeerCount(health.peers.trusted);
      setPeers(peerRows);
      setNetworkStatus({
        connectedPeers: health.network.connectedPeers,
        totalPeers: health.network.knownPeers,
        latency: health.network.averageLatencyMs,
        synchronization:
          storageSnapshot && storageKeys > 0 ? Math.round((replicatedKeys / storageKeys) * 100) : 0,
        packetRate: health.transports.messagesSent + health.transports.messagesReceived,
        replicationQueue: Math.max(0, storageKeys - replicatedKeys + pendingSync),
        connectionQuality:
          health.network.connectionQuality === 'good'
            ? 'Good'
            : health.network.connectionQuality === 'connected'
              ? 'Connected'
              : 'Offline',
        isOnline: health.network.running,
      });
    } catch (error) {
      logger.error('refresh_failed', error);
      setNetworkStatus(emptyStatus);
      setPeers([]);
      setLocalPeerId('Unavailable');
      setListenAddresses([]);
      setWebRtcSessions([]);
      setSignalingStatus(null);
      setStorageHealth(null);
      setCanConnectPeers(false);
      setHasLocalIdentity(false);
      setTrustedPeerCount(0);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleCopyPeerUri = useCallback(() => {
    void appService
      .getPeerInviteService()
      .createInvite()
      .then((peerUri) => {
        Clipboard.setString(peerUri);
        Alert.alert('Peer invite copied', 'Share this invite with another device.');
      })
      .catch((error) => {
        Alert.alert(
          'Invite unavailable',
          error instanceof Error ? error.message : 'Unable to create peer invite.',
        );
      });
  }, []);

  const handleImportInvite = useCallback(() => {
    try {
      const peer = appService.getPeerInviteService().importInvite(inviteUri);
      setInviteUri('');
      setTrustedPeerCount(appService.getTrustedPeerRepository().list().length);
      Alert.alert('Peer saved', `Peer ${peer.peerId.slice(0, 16)} is ready for reconnect.`);
    } catch (error) {
      Alert.alert(
        'Invalid invite',
        error instanceof Error ? error.message : 'Unable to import peer invite.',
      );
    }
  }, [inviteUri]);

  const ensureIdentityForPairing = useCallback(() => {
    if (hasLocalIdentity || appService.getLocalPeerId()) {
      return true;
    }
    setConnectionStep('Create a local identity before connecting peers.');
    Alert.alert(
      'Identity required',
      'Create your local identity first. WebRTC pairing uses it to sign and identify this peer.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Create identity',
          onPress: () => router.push('/identity/create'),
        },
      ],
    );
    return false;
  }, [hasLocalIdentity]);

  const handleCreateOffer = useCallback(async () => {
    if (!ensureIdentityForPairing()) {
      return;
    }
    if (!canConnectPeers) {
      Alert.alert('WebRTC unavailable', 'This browser runtime does not expose RTCPeerConnection.');
      return;
    }

    setConnecting(true);
    try {
      const offer = await appService.createPeerOffer();
      setGeneratedCode(offer);
      setConnectionStep('Connection code copied. Send it to the other device.');
      Clipboard.setString(offer);
      await refreshNetworkStatus();
      Alert.alert('Connection code copied', 'Send it to the other device.');
    } catch (error) {
      logger.error('create_offer_failed', error);
      Alert.alert(
        'Offer failed',
        error instanceof Error ? error.message : 'Unable to create offer.',
      );
    } finally {
      setConnecting(false);
    }
  }, [canConnectPeers, ensureIdentityForPairing, refreshNetworkStatus]);

  const handleProcessConnectionCode = useCallback(async () => {
    const code = connectionCode.trim();
    if (!code) {
      Alert.alert('Missing code', 'Paste the connection code from the other device.');
      return;
    }
    if (!ensureIdentityForPairing()) {
      return;
    }

    setConnecting(true);
    try {
      const signal = decodeWebRtcSignal(code);
      if (signal.type === 'offer') {
        const answer = await appService.acceptPeerOffer(code);
        setGeneratedCode(answer);
        setConnectionCode('');
        setConnectionStep('Response code copied. Send it back to the first device.');
        Clipboard.setString(answer);
        await refreshNetworkStatus();
        Alert.alert('Response copied', 'Send this response back to the first device.');
        return;
      }

      if (!appService.hasPendingPeerOffer(signal.sessionId)) {
        Alert.alert(
          'No matching connection',
          'This response does not match an active connection started on this browser.',
        );
        return;
      }
      await appService.applyPeerAnswer(code);
      setConnectionCode('');
      setConnectionStep('Response accepted. Waiting for encrypted peer session.');
      await refreshNetworkStatus();
      Alert.alert('Connection applied', 'Waiting for the peer session to open.');
    } catch (error) {
      logger.error('connection_code_failed', error);
      Alert.alert(
        'Connection code failed',
        error instanceof Error ? error.message : 'Paste a valid code generated by the peer.',
      );
    } finally {
      setConnecting(false);
    }
  }, [connectionCode, ensureIdentityForPairing, refreshNetworkStatus]);

  const handleCopyGeneratedCode = useCallback(() => {
    if (!generatedCode) {
      return;
    }
    Clipboard.setString(generatedCode);
    Alert.alert('Code copied', 'Connection code copied again.');
  }, [generatedCode]);

  const handleRetrySignaling = useCallback(async () => {
    try {
      appService.retryWebRtcSignaling();
      setConnectionStep('Retrying automatic signaling...');
      await refreshNetworkStatus();
    } catch (error) {
      logger.error('retry_signaling_failed', error);
      Alert.alert(
        'Retry failed',
        error instanceof Error ? error.message : 'Unable to retry automatic signaling.',
      );
    }
  }, [refreshNetworkStatus]);

  useEffect(() => {
    const initialRefresh = globalThis.setTimeout(() => {
      void refreshNetworkStatus();
    }, 0);
    const interval = globalThis.setInterval(() => {
      void refreshNetworkStatus();
    }, 5000);

    return () => {
      globalThis.clearTimeout(initialRefresh);
      globalThis.clearInterval(interval);
    };
  }, [refreshNetworkStatus]);

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading network status...</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <View style={styles.header}>
        <Text style={styles.title}>Network Status</Text>
        <View
          style={[
            styles.statusBadge,
            networkStatus.isOnline ? styles.onlineBadge : styles.offlineBadge,
          ]}
        >
          <Text style={styles.statusText}>{networkStatus.isOnline ? 'Online' : 'Offline'}</Text>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Local Peer</Text>
        <View style={styles.card}>
          <Text style={styles.peerId}>{localPeerId}</Text>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Pairing</Text>
        <View style={styles.card}>
          <Text style={styles.fieldLabel}>Share address</Text>
          {listenAddresses.length === 0 ? (
            <Text style={styles.emptyText}>No listen address available in this environment.</Text>
          ) : (
            listenAddresses.map((address) => (
              <Text key={address} style={styles.addressText}>
                {address}
              </Text>
            ))
          )}
          <TouchableOpacity
            testID="copy-peer-invite"
            style={[
              styles.actionButton,
              listenAddresses.length === 0 &&
                localPeerId === 'Not started' &&
                styles.disabledButton,
            ]}
            onPress={handleCopyPeerUri}
            disabled={listenAddresses.length === 0 && localPeerId === 'Not started'}
          >
            <Text style={styles.actionButtonText}>Copy peer URI</Text>
          </TouchableOpacity>

          <View style={styles.divider} />
          <Text style={styles.fieldLabel}>Import invite</Text>
          <TextInput
            style={styles.input}
            value={inviteUri}
            onChangeText={setInviteUri}
            placeholder="synpeer:peer?v=1&peerId=..."
            placeholderTextColor="#636366"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity
            testID="import-peer-invite"
            style={[styles.actionButton, !inviteUri.trim() && styles.disabledButton]}
            onPress={handleImportInvite}
            disabled={!inviteUri.trim()}
          >
            <Text style={styles.actionButtonText}>Import invite</Text>
          </TouchableOpacity>

          <View style={styles.divider} />
          <Text style={styles.fieldLabel}>Connect devices</Text>
          <Text style={styles.helpText}>{connectionStep}</Text>
          <TouchableOpacity
            style={[styles.actionButton, (!canConnectPeers || connecting) && styles.disabledButton]}
            onPress={handleCreateOffer}
            disabled={!canConnectPeers || connecting}
          >
            <Text style={styles.actionButtonText}>
              {connecting ? 'Working...' : 'Create connection code'}
            </Text>
          </TouchableOpacity>
          {generatedCode ? (
            <View style={styles.generatedCodePanel}>
              <Text style={styles.generatedCodeTitle}>Code ready</Text>
              <TextInput
                style={[styles.input, styles.compactMultilineInput]}
                value={generatedCode}
                multiline
                editable={false}
              />
              <TouchableOpacity style={styles.secondaryButton} onPress={handleCopyGeneratedCode}>
                <Text style={styles.actionButtonText}>Copy code again</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>Code from other device</Text>
          <TextInput
            style={[
              styles.input,
              styles.compactMultilineInput,
              !canConnectPeers && styles.disabledInput,
            ]}
            value={connectionCode}
            onChangeText={setConnectionCode}
            placeholder="synpeer:signal?data=..."
            placeholderTextColor="#636366"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            editable={canConnectPeers}
          />
          <TouchableOpacity
            style={[
              styles.actionButton,
              (!connectionCode.trim() || connecting) && styles.disabledButton,
            ]}
            onPress={handleProcessConnectionCode}
            disabled={!connectionCode.trim() || connecting}
          >
            <Text style={styles.actionButtonText}>Use this code</Text>
          </TouchableOpacity>
          {!canConnectPeers && (
            <Text style={styles.helpText}>WebRTC is unavailable in this browser environment.</Text>
          )}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Connection</Text>
        <View style={styles.card}>
          <StatRow
            testID="network-connected-peers"
            label="Connected Peers"
            value={networkStatus.connectedPeers.toString()}
          />
          <StatRow label="Known Peers" value={networkStatus.totalPeers.toString()} />
          <StatRow label="Trusted Peers" value={trustedPeerCount.toString()} />
          <StatRow
            label="Connection Quality"
            value={networkStatus.connectionQuality}
            success={networkStatus.connectedPeers > 0}
          />
          <StatRow
            label="Latency"
            value={networkStatus.latency !== null ? `${networkStatus.latency}ms` : 'N/A'}
          />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Automatic Signaling</Text>
        <View style={styles.card}>
          {signalingStatus ? (
            <>
              <StatRow
                testID="automatic-signaling-status"
                label="Status"
                value={formatSignalingState(signalingStatus)}
                success={signalingStatus.state === 'connected'}
              />
              <StatRow
                label="Server"
                value={findWebSocketStatus(signalingStatus)?.url ?? 'Unavailable'}
              />
              <StatRow
                label="Pending messages"
                value={signalingStatus.pendingMessages.toString()}
              />
              <StatRow
                label="Retry"
                value={formatRetryState(findWebSocketStatus(signalingStatus))}
              />
              <TouchableOpacity style={styles.actionButton} onPress={handleRetrySignaling}>
                <Text style={styles.actionButtonText}>Retry signaling</Text>
              </TouchableOpacity>
            </>
          ) : (
            <Text style={styles.emptyText}>Automatic signaling has not started yet.</Text>
          )}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>WebRTC Sessions</Text>
        <View style={styles.card}>
          {webRtcSessions.length === 0 ? (
            <Text style={styles.emptyText}>No active WebRTC pairing sessions.</Text>
          ) : (
            webRtcSessions.map((session) => (
              <View
                key={session.sessionId}
                style={styles.sessionRow}
                testID={`webrtc-session-${session.sessionId}`}
              >
                <View style={styles.peerInfo}>
                  <Text style={styles.peerName}>
                    {session.direction === 'outbound' ? 'Outgoing session' : 'Incoming session'}
                  </Text>
                  <Text style={styles.peerId}>{session.peerId}</Text>
                  <Text style={styles.sessionId}>{session.sessionId}</Text>
                </View>
                <View style={[styles.sessionBadge, styles[`session_${session.state}`]]}>
                  <Text style={styles.sessionBadgeText}>{session.state}</Text>
                </View>
              </View>
            ))
          )}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Performance</Text>
        <View style={styles.card}>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Storage Sync</Text>
            <View style={styles.progressBar}>
              <View style={[styles.progressFill, { width: `${networkStatus.synchronization}%` }]} />
            </View>
            <Text style={styles.statValue}>{networkStatus.synchronization}%</Text>
          </View>
          <StatRow label="Transport Messages" value={networkStatus.packetRate.toString()} />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Storage & Media</Text>
        <View style={styles.card}>
          {storageHealth ? (
            <>
              <StatRow label="App Storage" value={formatBytes(storageHealth.totalUsedBytes)} />
              <StatRow
                label="Media Chunks"
                value={`${storageHealth.chunks} / ${formatBytes(storageHealth.mediaChunkBytes)}`}
              />
              <StatRow
                label="Complete Media"
                value={`${storageHealth.completeMediaObjects}/${storageHealth.mediaObjects}`}
                success={
                  storageHealth.mediaObjects === 0 ||
                  storageHealth.completeMediaObjects === storageHealth.mediaObjects
                }
              />
              <StatRow
                label="Active Downloads"
                value={storageHealth.activeDownloads.toString()}
                success={storageHealth.activeDownloads === 0}
              />
              <StatRow
                label="Replicated Keys"
                value={`${storageHealth.replicatedKeys}/${storageHealth.totalKeys}`}
                success={
                  storageHealth.totalKeys === 0 ||
                  storageHealth.replicatedKeys >= storageHealth.totalKeys
                }
              />
              <StatRow
                label="Orphans"
                value={`${storageHealth.orphanMediaObjects} media / ${storageHealth.orphanChunks} chunks`}
                success={storageHealth.orphanMediaObjects === 0 && storageHealth.orphanChunks === 0}
              />
            </>
          ) : (
            <Text style={styles.emptyText}>
              Storage health is unavailable until media services start.
            </Text>
          )}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Replication</Text>
        <View style={styles.card}>
          <StatRow label="Queue Size" value={networkStatus.replicationQueue.toString()} />
          <StatRow
            label="Status"
            value={networkStatus.replicationQueue === 0 ? 'Settled' : 'Pending'}
            success={networkStatus.replicationQueue === 0}
          />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Peer List</Text>
        <View style={styles.card}>
          {peers.length === 0 ? (
            <Text style={styles.emptyText}>No peers discovered yet</Text>
          ) : (
            peers.map((peer) => (
              <View key={peer.id} style={styles.peerRow}>
                <View style={styles.peerAvatar} />
                <View style={styles.peerInfo}>
                  <Text style={styles.peerName}>
                    {peer.connected ? 'Connected peer' : 'Discovered peer'}
                  </Text>
                  <Text style={styles.peerId}>{peer.id}</Text>
                </View>
                <View style={styles.peerStatus}>
                  <Text
                    style={[styles.peerStatusText, !peer.connected && styles.peerStatusTextMuted]}
                  >
                    {peer.connected ? 'Connected' : 'Known'}
                  </Text>
                  <Text style={styles.peerLatency}>
                    {peer.latency !== null ? `${peer.latency}ms` : 'N/A'}
                  </Text>
                </View>
              </View>
            ))
          )}
        </View>
      </View>
    </ScrollView>
  );
}

function StatRow({
  label,
  value,
  success = false,
  testID,
}: {
  label: string;
  value: string;
  success?: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.statRow} testID={testID}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, success && styles.statValueSuccess]}>{value}</Text>
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

function formatSignalingState(status: WebRtcAutoSignalingStatus): string {
  const supabase = findSupabaseStatus(status);
  if (supabase?.state === 'connected') {
    return 'Supabase Realtime connected';
  }
  const websocket = findWebSocketStatus(status);
  if (websocket?.state === 'connected') {
    return 'Local signaling connected';
  }
  const remote = findRemoteSignalingStatus(status);
  if (remote?.state === 'reconnecting') {
    return 'Reconnecting';
  }
  if (status.state === 'connected') {
    return 'Local fallback active';
  }
  if (!status.available) {
    return 'Unavailable';
  }
  return status.state;
}

function formatRetryState(status: WebRtcAutoSignalingStatus | null): string {
  const remote = findRemoteSignalingStatus(status);
  if (!remote || remote.state === 'connected') {
    return 'Idle';
  }
  if (remote.retryDelayMs) {
    return `Attempt ${remote.reconnectAttempt} in ${Math.ceil(remote.retryDelayMs / 1000)}s`;
  }
  return remote.reconnectAttempt > 0 ? `Attempt ${remote.reconnectAttempt}` : 'Idle';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050509',
  },
  contentContainer: {
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  loadingText: {
    fontSize: 16,
    color: '#8E8E93',
    marginTop: 12,
  },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  onlineBadge: {
    backgroundColor: 'rgba(52, 199, 89, 0.2)',
  },
  offlineBadge: {
    backgroundColor: 'rgba(255, 59, 48, 0.2)',
  },
  statusText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 12,
  },
  card: {
    backgroundColor: '#0A0A0F',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1C1C1E',
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1C1C1E',
  },
  statLabel: {
    fontSize: 16,
    color: '#FFFFFF',
    flex: 1,
  },
  statValue: {
    fontSize: 16,
    fontWeight: '600',
    color: '#8E8E93',
  },
  statValueSuccess: {
    color: '#34C759',
  },
  progressBar: {
    flex: 1,
    height: 8,
    backgroundColor: '#1C1C1E',
    borderRadius: 4,
    marginHorizontal: 12,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#34C759',
  },
  peerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1C1C1E',
  },
  peerAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#1C1C1E',
    marginRight: 12,
  },
  peerInfo: {
    flex: 1,
  },
  peerName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 2,
  },
  peerId: {
    fontSize: 12,
    color: '#8E8E93',
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  fieldLabelSpaced: {
    marginTop: 16,
  },
  addressText: {
    fontSize: 12,
    color: '#8E8E93',
    marginBottom: 8,
  },
  actionButton: {
    minHeight: 44,
    borderRadius: 8,
    backgroundColor: '#0A84FF',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    marginTop: 12,
  },
  actionButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  disabledButton: {
    opacity: 0.55,
  },
  divider: {
    height: 1,
    backgroundColor: '#1C1C1E',
    marginVertical: 16,
  },
  input: {
    minHeight: 48,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2C2C2E',
    backgroundColor: '#050509',
    color: '#FFFFFF',
    paddingHorizontal: 12,
    fontSize: 14,
  },
  multilineInput: {
    minHeight: 120,
    paddingTop: 12,
    textAlignVertical: 'top',
  },
  compactMultilineInput: {
    minHeight: 96,
    paddingTop: 12,
    textAlignVertical: 'top',
  },
  generatedCodePanel: {
    backgroundColor: '#050509',
    borderColor: '#1C1C1E',
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 12,
    padding: 12,
  },
  generatedCodeTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 8,
  },
  secondaryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#0A84FF',
    borderRadius: 8,
    justifyContent: 'center',
    marginTop: 10,
    minHeight: 38,
    paddingHorizontal: 12,
  },
  disabledInput: {
    opacity: 0.55,
  },
  helpText: {
    color: '#8E8E93',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 8,
  },
  peerStatus: {
    alignItems: 'flex-end',
  },
  peerStatusText: {
    fontSize: 12,
    color: '#34C759',
    marginBottom: 2,
  },
  peerStatusTextMuted: {
    color: '#8E8E93',
  },
  peerLatency: {
    fontSize: 12,
    color: '#8E8E93',
  },
  sessionRow: {
    alignItems: 'center',
    borderBottomColor: '#1C1C1E',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 12,
  },
  sessionId: {
    color: '#636366',
    fontSize: 11,
    marginTop: 3,
  },
  sessionBadge: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  sessionBadgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  session_created: {
    backgroundColor: 'rgba(142, 142, 147, 0.2)',
  },
  session_signaling: {
    backgroundColor: 'rgba(10, 132, 255, 0.22)',
  },
  session_connecting: {
    backgroundColor: 'rgba(255, 204, 0, 0.22)',
  },
  session_connected: {
    backgroundColor: 'rgba(48, 209, 88, 0.22)',
  },
  session_authenticated: {
    backgroundColor: 'rgba(50, 215, 75, 0.28)',
  },
  session_disconnected: {
    backgroundColor: 'rgba(142, 142, 147, 0.2)',
  },
  session_failed: {
    backgroundColor: 'rgba(255, 69, 58, 0.22)',
  },
  session_closed: {
    backgroundColor: 'rgba(99, 99, 102, 0.2)',
  },
  emptyText: {
    color: '#8E8E93',
    fontSize: 14,
  },
});
