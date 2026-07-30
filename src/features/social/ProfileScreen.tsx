import { router } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Button, Card, Input, Screen, Text } from '@/components/ui';
import type { Wallet } from '@/economy/RewardTypes';
import { useApplicationEvents } from '@/hooks/useApplicationEvents';
import type { ProfileData } from '@/models/Profile';
import { createLogger } from '@/observability/Logger';
import { appService } from '@/services/AppService';

interface ProfileSummary {
  profile: ProfileData | null;
  author: string | null;
  postCount: number;
  followerCount: number;
  followingCount: number;
  wallet: Wallet | null;
}

const logger = createLogger('ProfileScreen');

export function ProfileScreen() {
  const [summary, setSummary] = useState<ProfileSummary>({
    profile: null,
    author: null,
    postCount: 0,
    followerCount: 0,
    followingCount: 0,
    wallet: null,
  });
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) {
      setLoading(true);
      setError(null);
    }
    try {
      await appService.initialize();
      const author = appService.getLocalPeerId();
      const wallet = appService.getWalletService().getWallet();

      if (!author) {
        setSummary((current) => ({ ...current, author: null, wallet }));
        return;
      }

      const socialQuery = appService.getSocialQueryService();
      const profile = await socialQuery.getProfile(author);
      const [postCount, followerCount, followingCount] = await Promise.all([
        socialQuery.getPostCount(author),
        socialQuery.getFollowerCount(author),
        socialQuery.getFollowingCount(author),
      ]);

      setSummary({
        profile,
        author,
        postCount,
        followerCount,
        followingCount,
        wallet,
      });
      setDisplayName(profile?.displayName ?? '');
      setUsername(profile?.username ?? '');
      setBio(profile?.bio ?? '');
    } catch (caught) {
      logger.error('profile_load_failed', caught);
      if (!options.silent) {
        setError(caught instanceof Error ? caught.message : 'Nao foi possivel carregar o perfil');
      }
    } finally {
      if (!options.silent) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => {
      void loadProfile();
    }, 0);
    return () => {
      globalThis.clearTimeout(timeout);
    };
  }, [loadProfile]);

  const refreshProfileFromEvent = useCallback(() => {
    if (!editing) {
      return loadProfile({ silent: true });
    }
    return Promise.resolve();
  }, [editing, loadProfile]);
  useApplicationEvents(['profile'], refreshProfileFromEvent, { coalesceMs: 75 });

  async function saveProfile() {
    if (!summary.author) {
      router.push('/identity/create');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const cleanUsername = normalizeUsername(username || displayName || summary.author);
      const cleanDisplayName = displayName.trim();
      if (!cleanDisplayName) {
        throw new Error('Informe um nome publico');
      }

      await appService.getSocialApplicationService().updateLocalProfile({
        username: cleanUsername,
        displayName: cleanDisplayName,
        bio: bio.trim() || undefined,
      });

      setEditing(false);
      await loadProfile();
    } catch (caught) {
      logger.error('profile_save_failed', caught);
      setError(caught instanceof Error ? caught.message : 'Nao foi possivel salvar o perfil');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Button label="Feed" variant="ghost" onPress={() => router.push('/feed')} />
          <Button label="Ajustes" variant="ghost" onPress={() => router.push('/settings')} />
        </View>

        <Card>
          <View style={styles.cardContent}>
            {editing ? (
              <>
                <Input
                  label="Nome publico"
                  value={displayName}
                  onChangeText={setDisplayName}
                  placeholder="Seu nome"
                />
                <Input
                  label="Usuario"
                  value={username}
                  onChangeText={setUsername}
                  placeholder="usuario"
                />
                <Input label="Bio" value={bio} onChangeText={setBio} placeholder="Sobre voce" />
                <View style={styles.actions}>
                  <Button label="Cancelar" variant="ghost" onPress={() => setEditing(false)} />
                  <Button
                    label={saving ? 'Salvando...' : 'Salvar'}
                    onPress={saveProfile}
                    disabled={saving}
                  />
                </View>
              </>
            ) : (
              <>
                <Text variant="heading" tone="primary">
                  {summary.profile?.displayName ?? 'Perfil local'}
                </Text>
                <Text variant="bodySmall" tone="secondary">
                  {summary.profile?.username
                    ? `@${summary.profile.username}`
                    : (summary.author ?? 'Sem identidade local')}
                </Text>
                <Text variant="body" tone="secondary">
                  {summary.profile?.bio ?? 'Crie ou edite seu perfil para preencher esta area.'}
                </Text>
                <Text variant="bodySmall" tone="muted">
                  Wallet: {summary.wallet?.address ?? 'Indisponivel'}
                </Text>
                {summary.author ? (
                  <Button
                    label={summary.profile ? 'Editar perfil' : 'Criar perfil'}
                    onPress={() => setEditing(true)}
                  />
                ) : null}
              </>
            )}
          </View>
        </Card>

        {loading ? (
          <Text variant="body" tone="secondary">
            Carregando perfil...
          </Text>
        ) : null}

        {error ? (
          <Text variant="bodySmall" tone="danger">
            {error}
          </Text>
        ) : null}

        {!summary.author ? (
          <Button
            label="Criar identidade"
            fullWidth
            onPress={() => router.push('/identity/create')}
          />
        ) : null}

        <View style={styles.stats}>
          <Card>
            <Text variant="caption" tone="muted">
              Posts
            </Text>
            <Text variant="body" tone="primary">
              {summary.postCount}
            </Text>
          </Card>
          <Card>
            <Text variant="caption" tone="muted">
              Seguidores
            </Text>
            <Text variant="body" tone="primary">
              {summary.followerCount}
            </Text>
          </Card>
          <Card>
            <Text variant="caption" tone="muted">
              Seguindo
            </Text>
            <Text variant="body" tone="primary">
              {summary.followingCount}
            </Text>
          </Card>
        </View>
      </ScrollView>
    </Screen>
  );
}

function normalizeUsername(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 30) || 'user'
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 16,
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    gap: 8,
  },
  cardContent: {
    gap: 10,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
  },
  stats: {
    gap: 12,
  },
});
