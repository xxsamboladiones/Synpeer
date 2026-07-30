import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Button, Card, Screen, Text } from '@/components/ui';
import { useApplicationEvents } from '@/hooks/useApplicationEvents';
import type { PostData } from '@/models/Post';
import type { ProfileData } from '@/models/Profile';
import { createLogger } from '@/observability/Logger';
import { appService } from '@/services/AppService';

interface PublicProfileState {
  profile: ProfileData | null;
  posts: PostData[];
  localPeerId: string | null;
  followerCount: number;
  followingCount: number;
  isFollowing: boolean;
}

const logger = createLogger('PublicProfileScreen');

export function PublicProfileScreen() {
  const params = useLocalSearchParams<{ author?: string | string[] }>();
  const author = useMemo(() => normalizeAuthorParam(params.author), [params.author]);
  const [state, setState] = useState<PublicProfileState>({
    profile: null,
    posts: [],
    localPeerId: null,
    followerCount: 0,
    followingCount: 0,
    isFollowing: false,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProfile = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!options.silent) {
        setLoading(true);
        setError(null);
      }
      try {
        if (!author) {
          throw new Error('Perfil invalido');
        }

        await appService.initialize();
        const socialQuery = appService.getSocialQueryService();
        const localPeerId = appService.getLocalPeerId();
        const [profile, posts, followerCount, followingCount, isFollowing] = await Promise.all([
          socialQuery.getProfile(author),
          socialQuery.getAuthorPosts(author),
          socialQuery.getFollowerCount(author),
          socialQuery.getFollowingCount(author),
          localPeerId ? socialQuery.isFollowing(localPeerId, author) : false,
        ]);

        setState({
          profile,
          posts,
          localPeerId,
          followerCount,
          followingCount,
          isFollowing,
        });
      } catch (caught) {
        logger.error('public_profile_load_failed', caught, { author: author ?? undefined });
        if (!options.silent) {
          setError(caught instanceof Error ? caught.message : 'Nao foi possivel carregar o perfil');
        }
      } finally {
        if (!options.silent) {
          setLoading(false);
        }
      }
    },
    [author],
  );

  useEffect(() => {
    const timeout = setTimeout(() => {
      void loadProfile();
    }, 0);

    return () => clearTimeout(timeout);
  }, [loadProfile]);
  const refreshProfileFromEvent = useCallback(() => loadProfile({ silent: true }), [loadProfile]);
  useApplicationEvents(['profile'], refreshProfileFromEvent, { coalesceMs: 75 });

  async function toggleFollow() {
    if (!author || !state.localPeerId || state.localPeerId === author) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (state.isFollowing) {
        await appService.getSocialApplicationService().createUnfollow({ followingId: author });
      } else {
        await appService.getSocialApplicationService().createFollow({ followingId: author });
      }
    } catch (caught) {
      logger.error('public_profile_follow_toggle_failed', caught, { author });
      setError('Nao foi possivel atualizar essa relacao.');
    } finally {
      setSaving(false);
    }
  }

  const isLocalProfile = Boolean(author && state.localPeerId === author);

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Button label="Voltar" variant="ghost" onPress={() => router.back()} />
          {isLocalProfile ? (
            <Button label="Editar local" variant="ghost" onPress={() => router.push('/profile')} />
          ) : null}
        </View>

        <Card>
          <View style={styles.profileContent}>
            <Text variant="heading" tone="primary">
              {state.profile?.displayName ?? 'Perfil desconhecido'}
            </Text>
            <Text variant="bodySmall" tone="secondary">
              {state.profile?.username ? `@${state.profile.username}` : (author ?? 'Sem autor')}
            </Text>
            <Text variant="body" tone="secondary">
              {state.profile?.bio ?? 'Esse perfil ainda nao publicou metadados locais.'}
            </Text>
            <Text variant="bodySmall" tone="muted">
              Peer: {author ?? 'Indisponivel'}
            </Text>
            {!isLocalProfile && state.localPeerId ? (
              <Button
                label={saving ? 'Salvando...' : state.isFollowing ? 'Deixar de seguir' : 'Seguir'}
                onPress={toggleFollow}
                disabled={saving || loading}
              />
            ) : null}
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

        <View style={styles.stats}>
          <Card>
            <Text variant="caption" tone="muted">
              Posts
            </Text>
            <Text variant="body" tone="primary">
              {state.posts.length}
            </Text>
          </Card>
          <Card>
            <Text variant="caption" tone="muted">
              Seguidores
            </Text>
            <Text variant="body" tone="primary">
              {state.followerCount}
            </Text>
          </Card>
          <Card>
            <Text variant="caption" tone="muted">
              Seguindo
            </Text>
            <Text variant="body" tone="primary">
              {state.followingCount}
            </Text>
          </Card>
        </View>

        <View style={styles.section}>
          <Text variant="title" tone="primary">
            Posts
          </Text>
          {state.posts.length === 0 ? (
            <Card>
              <Text variant="body" tone="secondary">
                Nenhum post sincronizado para este perfil.
              </Text>
            </Card>
          ) : (
            state.posts.map((post) => (
              <Card key={post.id}>
                <View style={styles.postContent}>
                  <Text variant="body" tone="primary">
                    {post.text}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {new Date(post.createdAt).toLocaleString()}
                  </Text>
                </View>
              </Card>
            ))
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

function normalizeAuthorParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
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
  profileContent: {
    gap: 10,
  },
  stats: {
    gap: 12,
  },
  section: {
    gap: 12,
  },
  postContent: {
    gap: 8,
  },
});
