import React, { useCallback, useEffect, useState } from 'react';
import { router } from 'expo-router';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  ActivityIndicator,
  TouchableOpacity,
} from 'react-native';
import type { PostData } from '@/models/Post';
import type { ProfileData } from '@/models/Profile';
import { useApplicationEvents } from '@/hooks/useApplicationEvents';
import type { PeerId } from '@/network/NetworkTypes';
import { createLogger } from '@/observability/Logger';
import { appService } from '@/services/AppService';

const logger = createLogger('DiscoverScreen');

export default function DiscoverScreen() {
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionPeerId, setActionPeerId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [localPeerId, setLocalPeerId] = useState<string | null>(null);
  const [posts, setPosts] = useState<PostData[]>([]);
  const [profiles, setProfiles] = useState<ProfileData[]>([]);
  const [followingByPeer, setFollowingByPeer] = useState<Record<string, boolean>>({});

  const loadDiscoverData = useCallback(async () => {
    await appService.initialize();
    const socialQuery = appService.getSocialQueryService();
    const currentPeerId = appService.getLocalPeerId();
    const [nextPosts, nextProfiles] = await Promise.all([
      socialQuery.getFeed(),
      socialQuery.getProfiles(),
    ]);
    const visibleProfiles = dedupeProfilesByAuthor(
      nextProfiles.filter((profile) => profile.author !== currentPeerId),
    );
    const following = currentPeerId
      ? await appService.getFollowRepository().getFollowing(currentPeerId, 1000, 0)
      : [];
    const followingMap = Object.fromEntries(
      visibleProfiles.map((profile) => [
        profile.author,
        following.some((follow) => follow.followingId === profile.author && !follow.deleted),
      ]),
    );

    setLocalPeerId(currentPeerId);
    setPosts(nextPosts);
    setProfiles(visibleProfiles);
    setFollowingByPeer(followingMap);
  }, []);

  useEffect(() => {
    const initializeDiscover = async () => {
      try {
        await loadDiscoverData();
      } catch (error) {
        logger.error('discover_initialize_failed', error);
        setPosts([]);
        setProfiles([]);
        setErrorMessage('Discover is unavailable right now.');
      } finally {
        setLoading(false);
      }
    };
    void initializeDiscover();
  }, [loadDiscoverData]);
  useApplicationEvents(['discover'], loadDiscoverData, { coalesceMs: 100 });

  const normalizedSearch = searchQuery.toLowerCase();
  const filteredProfiles = profiles.filter(
    (profile) =>
      profile.displayName.toLowerCase().includes(normalizedSearch) ||
      profile.username.toLowerCase().includes(normalizedSearch) ||
      profile.author.toLowerCase().includes(normalizedSearch) ||
      (profile.bio?.toLowerCase().includes(normalizedSearch) ?? false),
  );
  const filteredPosts = posts.filter(
    (post) =>
      post.text.toLowerCase().includes(normalizedSearch) ||
      post.author.toLowerCase().includes(normalizedSearch),
  );

  const toggleFollowProfile = async (profile: ProfileData) => {
    const targetPeerId = profile.author as PeerId;
    if (!localPeerId) {
      setErrorMessage('Create an identity before following peers.');
      return;
    }
    if (targetPeerId === localPeerId || actionPeerId) {
      return;
    }

    const wasFollowing = followingByPeer[targetPeerId] ?? false;
    setActionPeerId(targetPeerId);
    setErrorMessage(null);
    try {
      if (wasFollowing) {
        await appService.getSocialApplicationService().createUnfollow({
          followingId: targetPeerId,
        });
      } else {
        await appService.getSocialApplicationService().createFollow({ followingId: targetPeerId });
      }
      setFollowingByPeer((current) => ({
        ...current,
        [targetPeerId]: !wasFollowing,
      }));
    } catch (error) {
      logger.error('discover_follow_toggle_failed', error, { peerId: targetPeerId });
      setErrorMessage('Could not update this peer relationship.');
    } finally {
      setActionPeerId(null);
    }
  };

  const openProfile = (profile: ProfileData) => {
    router.push({
      pathname: '/profile/[author]',
      params: { author: profile.author },
    });
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading discover...</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <View style={styles.header}>
        <Text style={styles.title}>Discover</Text>
      </View>

      <View style={styles.searchContainer}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search people, posts, media..."
          placeholderTextColor="#8E8E93"
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
      </View>

      {errorMessage ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>People</Text>
        {filteredProfiles.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.cardText}>No profiles found</Text>
            <Text style={styles.cardSubtext}>Profiles appear here after identity sync.</Text>
          </View>
        ) : (
          filteredProfiles.map((profile) => {
            const isFollowing = followingByPeer[profile.author] ?? false;
            const isBusy = actionPeerId === profile.author;

            return (
              <View
                key={profile.author}
                style={styles.profileCard}
                testID={`discover-profile-${profile.author}`}
              >
                <TouchableOpacity style={styles.profileBody} onPress={() => openProfile(profile)}>
                  <Text style={styles.profileName}>{profile.displayName}</Text>
                  <Text style={styles.profileHandle}>@{profile.username}</Text>
                  {profile.bio ? <Text style={styles.profileBio}>{profile.bio}</Text> : null}
                  <Text style={styles.cardSubtext}>{profile.author}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  testID={`discover-follow-${profile.author}`}
                  style={[styles.followButton, isFollowing ? styles.followButtonDisabled : null]}
                  disabled={Boolean(actionPeerId)}
                  onPress={() => void toggleFollowProfile(profile)}
                >
                  <Text style={styles.followButtonText}>
                    {isBusy ? 'Saving...' : isFollowing ? 'Unfollow' : 'Follow'}
                  </Text>
                </TouchableOpacity>
              </View>
            );
          })
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Recent Posts</Text>
        {filteredPosts.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.cardText}>No posts found</Text>
            <Text style={styles.cardSubtext}>Be the first to share something!</Text>
          </View>
        ) : (
          filteredPosts.map((post) => (
            <View key={post.id} style={styles.card}>
              <Text style={styles.cardAuthor}>{post.author}</Text>
              <Text style={styles.cardText}>{post.text}</Text>
              <Text style={styles.cardSubtext}>{new Date(post.createdAt).toLocaleString()}</Text>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

function dedupeProfilesByAuthor(profiles: ProfileData[]): ProfileData[] {
  const byAuthor = new Map<string, ProfileData>();
  for (const profile of profiles) {
    const current = byAuthor.get(profile.author);
    if (!current || profile.updatedAt > current.updatedAt) {
      byAuthor.set(profile.author, profile);
    }
  }
  return Array.from(byAuthor.values()).sort((left, right) => right.updatedAt - left.updatedAt);
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
  searchContainer: {
    marginBottom: 24,
  },
  searchInput: {
    backgroundColor: '#0A0A0F',
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    color: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#1C1C1E',
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
  errorBanner: {
    backgroundColor: '#2A1212',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: '#5C2525',
    marginBottom: 16,
  },
  errorText: {
    color: '#FFB4B4',
    fontSize: 14,
  },
  card: {
    backgroundColor: '#0A0A0F',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1C1C1E',
    marginBottom: 12,
  },
  profileCard: {
    backgroundColor: '#0A0A0F',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1C1C1E',
    marginBottom: 12,
    gap: 12,
  },
  profileBody: {
    gap: 4,
  },
  profileName: {
    fontSize: 17,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  profileHandle: {
    fontSize: 14,
    color: '#64D2FF',
  },
  profileBio: {
    fontSize: 15,
    color: '#D1D1D6',
    lineHeight: 21,
  },
  followButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#007AFF',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  followButtonDisabled: {
    backgroundColor: '#2C2C2E',
  },
  followButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  cardAuthor: {
    fontSize: 14,
    fontWeight: '600',
    color: '#007AFF',
    marginBottom: 4,
  },
  cardText: {
    fontSize: 16,
    color: '#FFFFFF',
    marginBottom: 4,
  },
  cardSubtext: {
    fontSize: 14,
    color: '#8E8E93',
  },
});
