import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Clipboard,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';

import { appService } from '@/services/AppService';
import type { StorageHealthSnapshot } from '@/runtime/StorageHealth';

const DEVELOPER_MODE_KEY = 'synpeer:developerMode';
const LEGACY_DEVELOPER_MODE_KEY = 'insta99:developerMode';

const developerTools = [
  { route: '/developer/network-monitor', marker: 'NET', label: 'Network Monitor' },
  { route: '/developer/consensus-dashboard', marker: 'CON', label: 'Consensus Dashboard' },
  { route: '/developer/social-inspector', marker: 'SOC', label: 'Social Inspector' },
  { route: '/developer/logs', marker: 'LOG', label: 'Logs' },
  { route: '/developer/protocol-version', marker: 'VER', label: 'Protocol Version' },
  { route: '/developer/storage-inspector', marker: 'STO', label: 'Storage Inspector' },
] as const;

export default function SettingsScreen() {
  const router = useRouter();
  const [developerMode, setDeveloperMode] = useState(readDeveloperModePreference);
  const [darkMode, setDarkMode] = useState(true);
  const [storageUsage, setStorageUsage] = useState('0 MB');
  const [storageHealth, setStorageHealth] = useState<StorageHealthSnapshot | null>(null);
  const [identityImportVisible, setIdentityImportVisible] = useState(false);
  const [identityImportText, setIdentityImportText] = useState('');
  const [identityStatus, setIdentityStatus] = useState<string | null>(null);
  const [identityBusy, setIdentityBusy] = useState(false);

  const refreshStorageUsage = useCallback(async () => {
    await appService.initialize();
    const health = await appService.getStorageHealth();
    setStorageHealth(health);
    setStorageUsage(formatBytes(health.totalUsedBytes));
  }, []);

  useEffect(() => {
    const refresh = globalThis.setTimeout(() => {
      void refreshStorageUsage();
    }, 0);

    return () => {
      globalThis.clearTimeout(refresh);
    };
  }, [refreshStorageUsage]);

  const handleDeveloperModeToggle = (value: boolean) => {
    persistDeveloperModePreference(value);
    setDeveloperMode(value);
    if (value) {
      Alert.alert('Developer Mode', 'Developer tools are now enabled');
    }
  };

  const handleExportIdentity = async () => {
    await runIdentityAction('Export Identity', async () => {
      const backup = await appService.exportIdentityBackup();
      await copyText(backup);
      setIdentityStatus('Identity backup copied to clipboard.');
      Alert.alert('Export Identity', 'Identity backup copied to clipboard');
    });
  };

  const handleBackupIdentity = async () => {
    await runIdentityAction('Backup Identity', async () => {
      const backup = await appService.exportIdentityBackup();
      const downloaded = downloadTextFile(createIdentityBackupFilename(), backup);
      if (!downloaded) {
        await copyText(backup);
        setIdentityStatus('Browser download unavailable. Backup copied to clipboard.');
        Alert.alert('Backup Identity', 'Download unavailable. Backup copied to clipboard');
        return;
      }
      setIdentityStatus('Identity backup file downloaded.');
      Alert.alert('Backup Identity', 'Identity backup file downloaded');
    });
  };

  const handleImportIdentity = async () => {
    const backup = identityImportText.trim();
    if (!backup) {
      Alert.alert('Import Identity', 'Paste a backup JSON or choose a backup file first.');
      return;
    }

    await runIdentityAction('Import Identity', async () => {
      const peerId = await appService.importIdentityBackup(backup);
      setIdentityImportText('');
      setIdentityImportVisible(false);
      setIdentityStatus(`Identity restored: ${shortPeerId(peerId)}`);
      await refreshStorageUsage();
      Alert.alert('Import Identity', 'Identity restored successfully');
      reloadBrowserApp();
    });
  };

  const handleChooseIdentityBackupFile = async () => {
    const text = await readTextFileFromBrowser();
    if (text) {
      setIdentityImportText(text);
      setIdentityStatus('Backup file loaded. Confirm import to restore it.');
    }
  };

  const runIdentityAction = async (title: string, action: () => Promise<void>) => {
    if (identityBusy) {
      return;
    }
    setIdentityBusy(true);
    setIdentityStatus(null);
    try {
      await action();
    } catch (error) {
      const message = getSafeErrorMessage(error);
      setIdentityStatus(message);
      Alert.alert(title, message);
    } finally {
      setIdentityBusy(false);
    }
  };

  const handleClearPeerData = () => {
    void confirmDestructiveAction({
      title: 'Clear Peer Data',
      message:
        'Remove trusted peers, WebRTC sync state, replication queues and peer media manifests from this device?',
      confirmLabel: 'Clear',
      onConfirm: async () => {
        const result = await appService.clearPeerData();
        await refreshStorageUsage();
        Alert.alert(
          'Peer Data Cleared',
          `Removed ${result.trustedPeers} trusted peer(s), ${result.syncCheckpoints} sync checkpoint(s), ${result.replicationQueueItems} queued sync item(s), ${result.mediaDownloadStates} media download state(s), and ${result.mediaAvailabilityManifests} media manifest(s).`,
        );
      },
    });
  };

  const handleClearLocalData = () => {
    void confirmDestructiveAction({
      title: 'Clear Local Data',
      message:
        'This removes identity, wallet, posts, chats, media cache, peer data and local database records from this device.',
      confirmLabel: 'Clear Everything',
      onConfirm: async () => {
        const result = await appService.clearLocalData();
        setDeveloperMode(readDeveloperModePreference());
        await refreshStorageUsage();
        Alert.alert(
          'Local Data Cleared',
          `Identity, wallet, local database and media cache were cleared. Removed ${result.trustedPeers} peer(s) and ${result.replicationQueueItems} queued sync item(s).`,
        );
        router.replace('/feed');
        reloadBrowserApp();
      },
    });
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
      </View>

      <Section title="Appearance">
        <SettingRow label="Dark Mode">
          <Switch value={darkMode} onValueChange={setDarkMode} />
        </SettingRow>
      </Section>

      <Section title="Developer Mode">
        <SettingRow label="Enable Developer Mode">
          <Switch value={developerMode} onValueChange={handleDeveloperModeToggle} />
        </SettingRow>

        {developerMode ? (
          <View style={styles.developerTools}>
            {developerTools.map((tool) => (
              <TouchableOpacity
                key={tool.route}
                style={styles.developerTool}
                onPress={() => router.push(tool.route)}
              >
                <Text style={styles.developerToolMarker}>{tool.marker}</Text>
                <Text style={styles.developerToolText}>{tool.label}</Text>
                <Text style={styles.developerToolArrow}>{'>'}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
      </Section>

      <Section title="Storage">
        <SettingRow label="Storage Usage" value={storageUsage} onPress={refreshStorageUsage} />
        <SettingRow
          label="Media Cache"
          value={
            storageHealth
              ? `${storageHealth.completeMediaObjects}/${storageHealth.mediaObjects} complete`
              : 'Unavailable'
          }
          onPress={refreshStorageUsage}
        />
        <SettingRow
          label="Media Chunks"
          value={
            storageHealth
              ? `${storageHealth.chunks} chunks - ${formatBytes(storageHealth.mediaChunkBytes)}`
              : 'Unavailable'
          }
          onPress={refreshStorageUsage}
        />
        <SettingRow
          label="Replication"
          value={
            storageHealth
              ? `${storageHealth.replicatedKeys}/${storageHealth.totalKeys} keys`
              : 'Unavailable'
          }
          onPress={refreshStorageUsage}
        />
        <SettingRow
          label="Cleanup Candidates"
          value={
            storageHealth
              ? `${storageHealth.orphanMediaObjects} media / ${storageHealth.orphanChunks} chunks`
              : 'Unavailable'
          }
          onPress={refreshStorageUsage}
        />
      </Section>

      <Section title="Network">
        <SettingRow label="Network Status" value=">" onPress={() => router.push('/network')} />
      </Section>

      <Section title="Contribution">
        <SettingRow
          label="Contribution Dashboard"
          value=">"
          onPress={() => router.push('/contribution')}
        />
      </Section>

      <Section title="Privacy">
        <SettingRow label="Anonymous Mode">
          <Switch value={false} disabled />
        </SettingRow>
      </Section>

      <Section title="Identity">
        <SettingRow
          label={identityBusy ? 'Exporting...' : 'Export Identity'}
          value=">"
          onPress={handleExportIdentity}
        />
        <SettingRow
          label={identityBusy ? 'Creating backup...' : 'Backup Identity'}
          value=">"
          onPress={handleBackupIdentity}
        />
        <SettingRow
          label="Import Identity"
          value={identityImportVisible ? 'v' : '>'}
          onPress={() => setIdentityImportVisible((visible) => !visible)}
        />
        {identityImportVisible ? (
          <View style={styles.identityImportBox}>
            <Text style={styles.identityHelpText}>
              Paste a Synpeer identity backup JSON or choose a backup file.
            </Text>
            <TextInput
              multiline
              value={identityImportText}
              onChangeText={setIdentityImportText}
              placeholder="Paste backup JSON"
              placeholderTextColor="#6F6F78"
              style={styles.identityImportInput}
              editable={!identityBusy}
            />
            <View style={styles.identityButtonRow}>
              <TouchableOpacity
                style={[styles.identityButton, identityBusy && styles.identityButtonDisabled]}
                disabled={identityBusy}
                onPress={() => void handleChooseIdentityBackupFile()}
              >
                <Text style={styles.identityButtonText}>Choose file</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.identityButton, identityBusy && styles.identityButtonDisabled]}
                disabled={identityBusy}
                onPress={() => void handleImportIdentity()}
              >
                <Text style={styles.identityButtonText}>
                  {identityBusy ? 'Importing...' : 'Import'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}
        {identityStatus ? <Text style={styles.identityStatus}>{identityStatus}</Text> : null}
      </Section>

      <Section title="Danger Zone" danger>
        <SettingRow label="Clear Peer & Sync Data" value=">" danger onPress={handleClearPeerData} />
        <SettingRow label="Clear All Local Data" value=">" danger onPress={handleClearLocalData} />
      </Section>

      <View style={styles.footer}>
        <Text style={styles.footerText}>Synpeer v2.0.0</Text>
        <Text style={styles.footerSubtext}>Protocol v2.0.0</Text>
      </View>
    </ScrollView>
  );
}

function Section({
  title,
  danger = false,
  children,
}: {
  title: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, danger && styles.dangerTitle]}>{title}</Text>
      <View style={[styles.card, danger && styles.dangerCard]}>{children}</View>
    </View>
  );
}

function SettingRow({
  label,
  value,
  danger = false,
  children,
  onPress,
}: {
  label: string;
  value?: string;
  danger?: boolean;
  children?: React.ReactNode;
  onPress?: () => void | Promise<void>;
}) {
  return (
    <TouchableOpacity
      style={styles.settingRow}
      disabled={!onPress}
      onPress={() => void onPress?.()}
    >
      <Text style={[styles.settingLabel, danger && styles.dangerLabel]}>{label}</Text>
      {children ?? <Text style={[styles.settingValue, danger && styles.dangerValue]}>{value}</Text>}
    </TouchableOpacity>
  );
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

function readDeveloperModePreference(): boolean {
  const storage = getBrowserStorage();
  const enabled =
    storage?.getItem(DEVELOPER_MODE_KEY) === 'enabled' ||
    storage?.getItem(LEGACY_DEVELOPER_MODE_KEY) === 'enabled';
  if (enabled) {
    storage?.setItem(DEVELOPER_MODE_KEY, 'enabled');
  }
  return enabled;
}

function persistDeveloperModePreference(enabled: boolean): void {
  const storage = getBrowserStorage();
  if (!storage) {
    return;
  }

  if (enabled) {
    storage.setItem(DEVELOPER_MODE_KEY, 'enabled');
  } else {
    storage.removeItem(DEVELOPER_MODE_KEY);
    storage.removeItem(LEGACY_DEVELOPER_MODE_KEY);
  }
}

async function confirmDestructiveAction({
  title,
  message,
  confirmLabel,
  onConfirm,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
}): Promise<void> {
  const browser = globalThis as { confirm?: (message?: string) => boolean };

  if (typeof browser.confirm === 'function') {
    if (!browser.confirm(`${title}\n\n${message}`)) {
      return;
    }
    await runConfirmedAction(title, onConfirm);
    return;
  }

  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: confirmLabel,
      style: 'destructive',
      onPress: () => {
        void runConfirmedAction(title, onConfirm);
      },
    },
  ]);
}

async function runConfirmedAction(title: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    Alert.alert(title, error instanceof Error ? error.message : 'Unable to clear local data');
  }
}

type BrowserStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function getBrowserStorage(): BrowserStorage | null {
  const scope = globalThis as { localStorage?: BrowserStorage };
  return scope.localStorage ?? null;
}

function reloadBrowserApp(): void {
  const scope = globalThis as { location?: { reload: () => void } };
  scope.location?.reload();
}

async function copyText(value: string): Promise<void> {
  const scope = globalThis as {
    navigator?: { clipboard?: { writeText: (text: string) => Promise<void> } };
  };
  if (scope.navigator?.clipboard?.writeText) {
    await scope.navigator.clipboard.writeText(value);
    return;
  }
  Clipboard.setString(value);
}

function downloadTextFile(filename: string, contents: string): boolean {
  const scope = globalThis as {
    Blob?: BrowserBlobConstructor;
    URL?: {
      createObjectURL: (blob: BrowserBlob) => string;
      revokeObjectURL: (url: string) => void;
    };
    document?: {
      createElement: (tagName: 'a') => {
        href: string;
        download: string;
        style: { display: string };
        click: () => void;
      };
      body?: {
        appendChild: (node: unknown) => void;
        removeChild: (node: unknown) => void;
      };
    };
  };

  if (!scope.Blob || !scope.URL || !scope.document?.body) {
    return false;
  }

  const blob = new scope.Blob([contents], { type: 'application/json;charset=utf-8' });
  const url = scope.URL.createObjectURL(blob);
  const link = scope.document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  scope.document.body.appendChild(link);
  link.click();
  scope.document.body.removeChild(link);
  scope.URL.revokeObjectURL(url);
  return true;
}

type BrowserBlob = unknown;
type BrowserBlobConstructor = new (parts: string[], options?: { type?: string }) => BrowserBlob;

async function readTextFileFromBrowser(): Promise<string | null> {
  const scope = globalThis as {
    document?: {
      createElement: (tagName: 'input') => BrowserFileInput;
    };
  };
  if (!scope.document) {
    Alert.alert('Import Identity', 'File picker is unavailable in this environment.');
    return null;
  }

  return await new Promise((resolve) => {
    const input = scope.document?.createElement('input');
    if (!input) {
      resolve(null);
      return;
    }

    input.type = 'file';
    input.accept = 'application/json,.json,text/plain';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      file
        .text()
        .then(resolve)
        .catch(() => resolve(null));
    };
    input.click();
  });
}

type BrowserFileInput = {
  type: string;
  accept: string;
  files?: ArrayLike<{ text: () => Promise<string> }> | null;
  onchange: (() => void) | null;
  click: () => void;
};

function createIdentityBackupFilename(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `synpeer-identity-backup-${timestamp}.json`;
}

function getSafeErrorMessage(error: unknown): string {
  if (isSafeError(error)) {
    return error.safeMessage;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unable to complete identity operation.';
}

function isSafeError(value: unknown): value is { safeMessage: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'safeMessage' in value &&
    typeof (value as { safeMessage?: unknown }).safeMessage === 'string'
  );
}

function shortPeerId(peerId: string): string {
  if (peerId.length <= 16) {
    return peerId;
  }
  return `${peerId.slice(0, 8)}...${peerId.slice(-8)}`;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#0A0A0F',
    borderColor: '#1C1C1E',
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  container: {
    backgroundColor: '#050509',
    flex: 1,
  },
  contentContainer: {
    padding: 16,
  },
  dangerCard: {
    borderColor: '#FF3B30',
  },
  dangerLabel: {
    color: '#FF3B30',
  },
  dangerTitle: {
    color: '#FF3B30',
  },
  dangerValue: {
    color: '#FF3B30',
  },
  developerTool: {
    alignItems: 'center',
    backgroundColor: '#0A0A0F',
    borderColor: '#1C1C1E',
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    padding: 16,
  },
  developerToolArrow: {
    color: '#8E8E93',
    fontSize: 18,
  },
  developerToolMarker: {
    backgroundColor: '#1C1C1E',
    borderRadius: 8,
    color: '#8E8E93',
    fontSize: 12,
    fontWeight: '700',
    marginRight: 12,
    minWidth: 42,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 6,
    textAlign: 'center',
  },
  developerToolText: {
    color: '#FFFFFF',
    flex: 1,
    fontSize: 16,
  },
  developerTools: {
    gap: 8,
    marginTop: 12,
  },
  footer: {
    alignItems: 'center',
    marginTop: 40,
    paddingVertical: 20,
  },
  footerSubtext: {
    color: '#8E8E93',
    fontSize: 12,
  },
  footerText: {
    color: '#8E8E93',
    fontSize: 14,
    marginBottom: 4,
  },
  header: {
    marginBottom: 20,
  },
  identityButton: {
    alignItems: 'center',
    backgroundColor: '#007AFF',
    borderRadius: 10,
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  identityButtonDisabled: {
    opacity: 0.55,
  },
  identityButtonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  identityButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  identityHelpText: {
    color: '#8E8E93',
    fontSize: 13,
    marginBottom: 10,
  },
  identityImportBox: {
    borderBottomColor: '#1C1C1E',
    borderBottomWidth: 1,
    gap: 10,
    padding: 16,
  },
  identityImportInput: {
    backgroundColor: '#11111A',
    borderColor: '#2C2C3A',
    borderRadius: 10,
    borderWidth: 1,
    color: '#FFFFFF',
    minHeight: 110,
    padding: 12,
    textAlignVertical: 'top',
  },
  identityStatus: {
    color: '#8E8E93',
    fontSize: 13,
    padding: 16,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  settingLabel: {
    color: '#FFFFFF',
    fontSize: 16,
  },
  settingRow: {
    alignItems: 'center',
    borderBottomColor: '#1C1C1E',
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 16,
  },
  settingValue: {
    color: '#8E8E93',
    fontSize: 16,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 32,
    fontWeight: 'bold',
  },
});
