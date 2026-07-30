import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Image,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';

import { Button, Card, Input, Screen, Text } from '@/components/ui';
import { useApplicationEvents, useConnectivitySnapshot } from '@/hooks/useApplicationEvents';
import type { CommentData } from '@/models/Comment';
import type { PostData, PostMediaAttachment } from '@/models/Post';
import type { ProfileData } from '@/models/Profile';
import { createLogger } from '@/observability/Logger';
import { appService } from '@/services/AppService';
import type { ApplicationConnectivitySnapshot } from '@/services/events/ApplicationEventService';
import type { MediaDownloadState } from '@/services/media/PeerMediaSyncService';

const logger = createLogger('HomeFeedScreen');

export function HomeFeedScreen() {
  const [author, setAuthor] = useState<string | null>(null);
  const [posts, setPosts] = useState<PostData[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [replicationStatus, setReplicationStatus] = useState<string | null>(null);
  const [commentsByPost, setCommentsByPost] = useState<Record<string, CommentData[]>>({});
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [reactionCounts, setReactionCounts] = useState<Record<string, number>>({});
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  const [reactedPosts, setReactedPosts] = useState<Record<string, boolean>>({});
  const [profilesByAuthor, setProfilesByAuthor] = useState<Record<string, ProfileData>>({});
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [savingPostId, setSavingPostId] = useState<string | null>(null);
  const loadingFeedRef = useRef(false);
  const mountedRef = useRef(true);
  const connectivity = useConnectivitySnapshot();

  const loadFeed = useCallback(async (options: { silent?: boolean } = {}) => {
    if (loadingFeedRef.current) {
      return;
    }
    loadingFeedRef.current = true;
    if (!options.silent) {
      setLoading(true);
      setError(null);
    }
    try {
      await appService.initialize();
      const localAuthor = appService.getLocalPeerId();
      const socialQuery = appService.getSocialQueryService();
      if (!mountedRef.current) {
        return;
      }
      setAuthor(localAuthor);
      const feedPosts = await socialQuery.getFeed();
      const nextCommentsByPost: Record<string, CommentData[]> = {};
      const nextReactionCounts: Record<string, number> = {};
      const nextCommentCounts: Record<string, number> = {};
      const nextReactedPosts: Record<string, boolean> = {};
      for (const post of feedPosts) {
        const [comments, commentCount, reactionCount, hasReacted] = await Promise.all([
          socialQuery.getCommentsForPost(post.id, 3),
          socialQuery.getCommentCountForPost(post.id),
          socialQuery.getReactionCountForPost(post.id),
          localAuthor ? socialQuery.hasReacted(localAuthor, post.id) : false,
        ]);
        nextCommentsByPost[post.id] = comments;
        nextCommentCounts[post.id] = commentCount;
        nextReactionCounts[post.id] = reactionCount;
        nextReactedPosts[post.id] = hasReacted;
      }
      const authors = Array.from(
        new Set([
          ...feedPosts.map((post) => post.author),
          ...Object.values(nextCommentsByPost)
            .flat()
            .map((comment) => comment.author),
        ]),
      );
      const profiles = await Promise.all(
        authors.map(
          async (profileAuthor) =>
            [profileAuthor, await socialQuery.getProfile(profileAuthor)] as const,
        ),
      );
      const nextProfilesByAuthor: Record<string, ProfileData> = {};
      for (const [profileAuthor, profile] of profiles) {
        if (profile) {
          nextProfilesByAuthor[profileAuthor] = profile;
        }
      }
      if (!mountedRef.current) {
        return;
      }
      setPosts(feedPosts);
      setCommentsByPost(nextCommentsByPost);
      setCommentCounts(nextCommentCounts);
      setReactionCounts(nextReactionCounts);
      setReactedPosts(nextReactedPosts);
      setProfilesByAuthor(nextProfilesByAuthor);
    } catch (caught) {
      logger.error('feed_load_failed', caught);
      if (!options.silent) {
        setError(caught instanceof Error ? caught.message : 'Nao foi possivel carregar o feed');
      }
    } finally {
      loadingFeedRef.current = false;
      if (mountedRef.current && !options.silent) {
        setLoading(false);
      }
    }
  }, []);
  const refreshFeedFromEvent = useCallback(() => loadFeed({ silent: true }), [loadFeed]);

  async function reactToPost(postId: string) {
    if (!author) {
      router.push('/identity/create');
      return;
    }
    try {
      const result = await appService.getSocialApplicationService().createReaction({ postId });
      setReplicationStatus(
        result.replication.attemptedPeers > 0
          ? `Curtida replicada para ${result.replication.successfulPeers} peer(s)`
          : 'Curtida salva localmente. Aguardando peers confiaveis.',
      );
    } catch (caught) {
      logger.error('post_reaction_failed', caught);
      setError(caught instanceof Error ? caught.message : 'Nao foi possivel curtir');
    }
  }

  async function commentOnPost(postId: string) {
    if (!author) {
      router.push('/identity/create');
      return;
    }
    const text = (commentDrafts[postId] ?? '').trim();
    if (!text) {
      setError('Escreva um comentario antes de enviar.');
      return;
    }

    try {
      const result = await appService.getSocialApplicationService().createComment({ postId, text });
      setReplicationStatus(
        result.replication.attemptedPeers > 0
          ? `Comentario replicado para ${result.replication.successfulPeers} peer(s)`
          : 'Comentario salvo localmente. Aguardando peers confiaveis.',
      );
      setCommentDrafts((current) => ({ ...current, [postId]: '' }));
    } catch (caught) {
      logger.error('post_comment_failed', caught);
      setError(caught instanceof Error ? caught.message : 'Nao foi possivel comentar');
    }
  }

  async function publishPost() {
    if (!author) {
      router.push('/identity/create');
      return;
    }

    const text = draft.trim();
    if (!text) {
      setError('Escreva algo antes de publicar.');
      return;
    }

    try {
      const result = await appService.getSocialApplicationService().createPost({ text });
      setReplicationStatus(
        result.replication.attemptedPeers > 0
          ? `Replicado para ${result.replication.successfulPeers} peer(s)`
          : 'Post salvo localmente. Aguardando peers confiaveis.',
      );
      setDraft('');
    } catch (caught) {
      logger.error('post_publish_failed', caught);
      setError(caught instanceof Error ? caught.message : 'Nao foi possivel publicar');
    }
  }

  async function savePostEdit(postId: string) {
    const text = editDraft.trim();
    if (!text) {
      setError('O post editado precisa ter texto.');
      return;
    }
    setSavingPostId(postId);
    setError(null);
    try {
      const result = await appService.getSocialApplicationService().editPost({ postId, text });
      setReplicationStatus(
        result.replication.attemptedPeers > 0
          ? `Edicao replicada para ${result.replication.successfulPeers} peer(s)`
          : 'Edicao salva localmente. Aguardando peers confiaveis.',
      );
      setEditingPostId(null);
      setEditDraft('');
    } catch (caught) {
      logger.error('post_edit_failed', caught, { postId });
      setError(caught instanceof Error ? caught.message : 'Nao foi possivel editar o post');
    } finally {
      setSavingPostId(null);
    }
  }

  async function deletePost(postId: string) {
    setSavingPostId(postId);
    setError(null);
    try {
      const result = await appService.getSocialApplicationService().deletePost({ postId });
      setReplicationStatus(
        result.replication.attemptedPeers > 0
          ? `Remocao replicada para ${result.replication.successfulPeers} peer(s)`
          : 'Post removido localmente. Aguardando peers confiaveis.',
      );
    } catch (caught) {
      logger.error('post_delete_failed', caught, { postId });
      setError(caught instanceof Error ? caught.message : 'Nao foi possivel apagar o post');
    } finally {
      setSavingPostId(null);
    }
  }

  function confirmDeletePost(postId: string) {
    if (Platform.OS === 'web') {
      const confirmed = globalThis.confirm?.(
        'Apagar este post? Esta remocao sera sincronizada com peers confiaveis.',
      );
      if (confirmed) {
        void deletePost(postId);
      }
      return;
    }
    Alert.alert('Apagar post', 'Esta remocao sera sincronizada com peers confiaveis.', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Apagar',
        style: 'destructive',
        onPress: () => {
          void deletePost(postId);
        },
      },
    ]);
  }

  useEffect(() => {
    mountedRef.current = true;
    const timeout = globalThis.setTimeout(() => {
      void loadFeed();
    }, 0);
    return () => {
      globalThis.clearTimeout(timeout);
      mountedRef.current = false;
    };
  }, [loadFeed]);

  useApplicationEvents(['feed'], refreshFeedFromEvent, { coalesceMs: 100 });

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View>
            <Text variant="heading" tone="primary">
              Synpeer
            </Text>
            <Text variant="bodySmall" tone="secondary">
              {formatConnectivityStatus(connectivity)}
            </Text>
          </View>
          <View style={styles.actions}>
            <Button label="Chat" variant="ghost" onPress={() => router.push('/chat')} />
            <Button label="Perfil" variant="ghost" onPress={() => router.push('/profile')} />
            <Button label="Ajustes" variant="ghost" onPress={() => router.push('/settings')} />
          </View>
        </View>

        <Card>
          <View style={styles.cardContent}>
            <Input
              label="Novo post"
              multiline
              placeholder={author ? 'O que esta acontecendo?' : 'Crie uma identidade para postar'}
              testID="feed-post-composer"
              value={draft}
              editable={Boolean(author)}
              onChangeText={setDraft}
            />
            <Button
              label={author ? 'Publicar' : 'Criar identidade'}
              testID="feed-publish-post"
              fullWidth
              onPress={publishPost}
            />
          </View>
        </Card>

        {error ? (
          <Text variant="bodySmall" tone="danger">
            {error}
          </Text>
        ) : null}

        {replicationStatus ? (
          <Text variant="bodySmall" tone="secondary">
            {replicationStatus}
          </Text>
        ) : null}

        {loading ? (
          <Text variant="body" tone="secondary">
            Carregando feed...
          </Text>
        ) : null}

        {!loading && posts.length === 0 ? (
          <Card>
            <Text variant="body" tone="secondary">
              Ainda nao ha posts locais ou sincronizados.
            </Text>
          </Card>
        ) : null}

        {posts.map((post) => (
          <Card key={post.id} testID={`post-card-${post.id}`}>
            <View style={styles.cardContent}>
              <View style={styles.postHeader}>
                <TouchableOpacity
                  onPress={() => router.push(`/profile/${encodeURIComponent(post.author)}`)}
                >
                  <Text variant="caption" tone="muted">
                    {formatProfileName(post.author, profilesByAuthor[post.author])}
                  </Text>
                </TouchableOpacity>
                {author === post.author ? (
                  <View style={styles.postManageActions}>
                    {editingPostId === post.id ? (
                      <Button
                        testID={`post-cancel-edit-${post.id}`}
                        label="Cancelar"
                        variant="ghost"
                        disabled={savingPostId === post.id}
                        onPress={() => {
                          setEditingPostId(null);
                          setEditDraft('');
                        }}
                      />
                    ) : (
                      <Button
                        testID={`post-edit-${post.id}`}
                        label="Editar"
                        variant="ghost"
                        disabled={savingPostId === post.id}
                        onPress={() => {
                          setEditingPostId(post.id);
                          setEditDraft(post.text);
                        }}
                      />
                    )}
                    <Button
                      testID={`post-delete-${post.id}`}
                      label="Apagar"
                      variant="ghost"
                      disabled={savingPostId === post.id}
                      onPress={() => confirmDeletePost(post.id)}
                    />
                  </View>
                ) : null}
              </View>
              {editingPostId === post.id ? (
                <View style={styles.editBlock}>
                  <Input
                    testID={`post-edit-input-${post.id}`}
                    label="Editar post"
                    multiline
                    value={editDraft}
                    onChangeText={setEditDraft}
                    editable={savingPostId !== post.id}
                  />
                  <Button
                    testID={`post-save-edit-${post.id}`}
                    label={savingPostId === post.id ? 'Salvando...' : 'Salvar alteracoes'}
                    fullWidth
                    disabled={savingPostId === post.id}
                    onPress={() => {
                      void savePostEdit(post.id);
                    }}
                  />
                </View>
              ) : (
                <Text variant="body" tone="primary">
                  {post.text}
                </Text>
              )}
              {(post.mediaAttachments ?? []).length > 0 ? (
                <View style={styles.mediaList}>
                  {(post.mediaAttachments ?? []).map((attachment) => (
                    <PostMediaPreview
                      key={attachment.id}
                      attachment={attachment}
                      author={post.author}
                      createdAt={post.createdAt}
                      updatedAt={post.updatedAt}
                      signature={post.signature}
                    />
                  ))}
                </View>
              ) : null}
              <Text variant="caption" tone="muted">
                {new Date(post.createdAt).toLocaleString()}
              </Text>
              <View style={styles.actions}>
                <Button
                  label={`${reactedPosts[post.id] ? 'Curtido' : 'Curtir'} (${reactionCounts[post.id] ?? 0})`}
                  variant="ghost"
                  onPress={() => {
                    void reactToPost(post.id);
                  }}
                />
                <Text variant="caption" tone="muted">
                  Comentarios: {commentCounts[post.id] ?? 0}
                </Text>
              </View>
              {(commentsByPost[post.id] ?? []).map((comment) => (
                <View key={comment.id} style={styles.comment}>
                  <TouchableOpacity
                    onPress={() => router.push(`/profile/${encodeURIComponent(comment.author)}`)}
                  >
                    <Text variant="caption" tone="muted">
                      {formatProfileName(comment.author, profilesByAuthor[comment.author])}
                    </Text>
                  </TouchableOpacity>
                  <Text variant="bodySmall" tone="secondary">
                    {comment.text}
                  </Text>
                </View>
              ))}
              <Input
                label="Comentar"
                placeholder={author ? 'Responder a este post' : 'Crie uma identidade para comentar'}
                value={commentDrafts[post.id] ?? ''}
                editable={Boolean(author)}
                onChangeText={(value) =>
                  setCommentDrafts((current) => ({ ...current, [post.id]: value }))
                }
              />
              <Button
                label="Enviar comentario"
                variant="ghost"
                onPress={() => {
                  void commentOnPost(post.id);
                }}
              />
            </View>
          </Card>
        ))}
      </ScrollView>
    </Screen>
  );
}

function formatConnectivityStatus(snapshot: ApplicationConnectivitySnapshot): string {
  if (snapshot.status === 'syncing') {
    return `Sincronizando com ${snapshot.syncingPeers} peer(s)`;
  }
  if (snapshot.connectedPeers > 0) {
    return `${snapshot.connectedPeers} peer(s) conectado(s) - feed local-first`;
  }
  if (snapshot.status === 'connecting' || snapshot.status === 'handshaking') {
    return 'Conectando a peers confiaveis';
  }
  if (snapshot.status === 'reconnecting') {
    return 'Reconectando a rede P2P';
  }
  if (snapshot.status === 'degraded') {
    return 'Rede P2P degradada - dados locais disponiveis';
  }
  return 'Offline - dados locais disponiveis';
}

function PostMediaPreview({
  attachment,
  author,
  createdAt,
  updatedAt,
  signature,
}: {
  attachment: PostMediaAttachment;
  author: string;
  createdAt: number;
  updatedAt: number;
  signature: string;
}) {
  const objectUrlRef = useRef<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [state, setState] = useState<{
    status: 'loading' | 'ready' | 'missing' | 'unsupported' | 'retrying';
    url?: string;
    error?: string;
    download?: MediaDownloadState | null;
  }>({ status: 'loading' });

  const loadLocalAttachment = useCallback(
    async (disposed: () => boolean): Promise<boolean> => {
      const webGlobals = getWebMediaGlobals();
      if (!webGlobals) {
        if (!disposed()) {
          setState({ status: 'unsupported' });
        }
        return false;
      }

      try {
        await ensureAttachmentMetadata({
          attachment,
          author,
          createdAt,
          updatedAt,
          signature,
        });
        const result = await appService.getMediaUploadService().getLocalMediaBytes(attachment.id);
        if (!result.success || !result.fileData) {
          if (!disposed()) {
            setState({
              status: 'missing',
              error: result.error ?? 'Media is not available locally',
              download: appService.getMediaDownloadState(attachment.id),
            });
          }
          return false;
        }

        if (objectUrlRef.current) {
          webGlobals.revokeObjectURL(objectUrlRef.current);
        }
        objectUrlRef.current = webGlobals.createObjectURL(
          new webGlobals.Blob([toArrayBuffer(result.fileData)], {
            type: attachment.mime || 'application/octet-stream',
          }),
        );
        if (!disposed()) {
          setState({ status: 'ready', url: objectUrlRef.current });
        }
        return true;
      } catch (caught) {
        if (!disposed()) {
          setState({
            status: 'missing',
            error: caught instanceof Error ? caught.message : 'Unable to load media',
          });
        }
        return false;
      }
    },
    [attachment, author, createdAt, signature, updatedAt],
  );

  useEffect(() => {
    let disposed = false;

    async function loadAttachment() {
      const available = await loadLocalAttachment(() => disposed);
      if (!available && shouldAutoDownloadAttachment(attachment)) {
        void appService.enqueueMediaDownload(attachment.id, 10);
      }
    }

    void loadAttachment();

    return () => {
      disposed = true;
      if (objectUrlRef.current) {
        getWebMediaGlobals()?.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [attachment, loadLocalAttachment]);

  useEffect(() => {
    let disposed = false;
    const unsubscribe = appService.subscribeMediaDownloads((download) => {
      if (download.mediaObjectId !== attachment.id || disposed) {
        return;
      }
      setState((current) => ({
        ...current,
        status:
          download.status === 'downloading' || download.status === 'queued'
            ? 'missing'
            : current.status,
        download,
        error:
          download.status === 'queued'
            ? 'Download queued'
            : download.status === 'downloading'
              ? 'Downloading media from peers...'
              : current.error,
      }));
      if (download.status === 'available') {
        void loadLocalAttachment(() => disposed);
      }
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [attachment.id, loadLocalAttachment]);

  async function retryDownload() {
    setState((current) => ({ ...current, status: 'retrying', error: undefined }));
    try {
      await ensureAttachmentMetadata({
        attachment,
        author,
        createdAt,
        updatedAt,
        signature,
      });
      await appService.retryMediaDownload(attachment.id);
      const result = await appService.getMediaUploadService().getLocalMediaBytes(attachment.id);
      if (!result.success || !result.fileData) {
        setState({
          status: 'missing',
          error: result.error ?? 'Media chunks are not available locally.',
          download: appService.getMediaDownloadState(attachment.id),
        });
        return;
      }
      const webGlobals = getWebMediaGlobals();
      if (!webGlobals) {
        setState({ status: 'unsupported' });
        return;
      }
      if (objectUrlRef.current) {
        webGlobals.revokeObjectURL(objectUrlRef.current);
      }
      const url = webGlobals.createObjectURL(
        new webGlobals.Blob([toArrayBuffer(result.fileData)], {
          type: attachment.mime || 'application/octet-stream',
        }),
      );
      objectUrlRef.current = url;
      setState({ status: 'ready', url });
    } catch (caught) {
      setState({
        status: 'missing',
        error: caught instanceof Error ? caught.message : 'Unable to retry media download',
        download: appService.getMediaDownloadState(attachment.id),
      });
    }
  }

  const title = attachment.name ?? attachment.id;
  const metadata = `${attachment.type} - ${attachment.mime || 'application/octet-stream'} - ${formatBytes(attachment.size)}`;

  if (state.status === 'loading') {
    return (
      <View style={styles.mediaCard}>
        <Text variant="bodySmall" tone="primary">
          {title}
        </Text>
        <Text variant="caption" tone="muted">
          Loading media from local chunks...
        </Text>
      </View>
    );
  }

  if (state.status !== 'ready' || !state.url) {
    const download = state.download ?? appService.getMediaDownloadState(attachment.id);
    const progress = download ? getDownloadProgressPercentage(download) : 0;
    const canCancel = download?.status === 'queued' || download?.status === 'downloading';
    const canRetry =
      state.status !== 'unsupported' && !canCancel && download?.status !== 'available';
    const primaryActionLabel = attachment.type === 'document' ? 'Download file' : 'Retry download';

    return (
      <View style={styles.mediaCard}>
        <View style={styles.mediaHeader}>
          <View style={styles.mediaTitleBlock}>
            <Text variant="bodySmall" tone="primary">
              {title}
            </Text>
            <Text variant="caption" tone="muted">
              {metadata}
            </Text>
          </View>
          <MediaStatusBadge status={download?.status ?? toMediaBadgeStatus(state.status)} />
        </View>
        <Text variant="caption" tone="muted">
          {formatMediaAvailabilityMessage(state.status, download, attachment)}
        </Text>
        {download ? (
          <View style={styles.mediaProgressBlock}>
            <View style={styles.mediaProgressTrack}>
              <View style={[styles.mediaProgressFill, { width: `${progress}%` }]} />
            </View>
            <Text variant="caption" tone="muted">
              {formatDownloadProgress(download, attachment)}
            </Text>
          </View>
        ) : null}
        {state.error && !download ? (
          <Text variant="caption" tone="danger">
            {state.error}
          </Text>
        ) : null}
        {canRetry || canCancel ? (
          <View style={styles.mediaActions}>
            {canRetry ? (
              <TouchableOpacity style={styles.downloadButton} onPress={() => void retryDownload()}>
                <Text variant="bodySmall" tone="primary">
                  {state.status === 'retrying' ? 'Retrying...' : primaryActionLabel}
                </Text>
              </TouchableOpacity>
            ) : null}
            {canCancel ? (
              <TouchableOpacity
                style={styles.downloadButton}
                onPress={() => {
                  void appService.cancelMediaDownload(attachment.id).then((cancelled) => {
                    if (cancelled) {
                      setState((current) => ({
                        ...current,
                        download: cancelled,
                        error: 'Download cancelled',
                      }));
                    }
                  });
                }}
              >
                <Text variant="bodySmall" tone="primary">
                  Cancel
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.mediaCard}>
      <Text variant="bodySmall" tone="primary">
        {title}
      </Text>
      <Text variant="caption" tone="muted">
        {metadata}
      </Text>
      <MediaStatusBadge status="available" />
      {attachment.type === 'image' ? (
        <>
          <TouchableOpacity
            activeOpacity={0.92}
            onPress={() => setViewerOpen(true)}
            style={styles.imagePreviewButton}
          >
            <Image source={{ uri: state.url }} style={styles.imagePreview} resizeMode="contain" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.downloadButton} onPress={() => setViewerOpen(true)}>
            <Text variant="bodySmall" tone="primary">
              Open full screen
            </Text>
          </TouchableOpacity>
          <Modal
            animationType="fade"
            transparent
            visible={viewerOpen}
            onRequestClose={() => setViewerOpen(false)}
          >
            <View style={styles.imageViewerOverlay}>
              <View style={styles.imageViewerHeader}>
                <Text variant="bodySmall" tone="primary">
                  {title}
                </Text>
                <TouchableOpacity
                  style={styles.imageViewerClose}
                  onPress={() => setViewerOpen(false)}
                >
                  <Text variant="bodySmall" tone="primary">
                    Close
                  </Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                activeOpacity={1}
                style={styles.imageViewerBody}
                onPress={() => setViewerOpen(false)}
              >
                <Image
                  source={{ uri: state.url }}
                  style={styles.imageViewerImage}
                  resizeMode="contain"
                />
              </TouchableOpacity>
            </View>
          </Modal>
        </>
      ) : null}
      {attachment.type === 'video'
        ? React.createElement('video', {
            src: state.url,
            controls: true,
            style: videoPreviewStyle,
          })
        : null}
      {attachment.type === 'audio'
        ? React.createElement('audio', {
            src: state.url,
            controls: true,
            style: audioPreviewStyle,
          })
        : null}
      {attachment.type === 'document' ? (
        <TouchableOpacity
          style={styles.downloadButton}
          onPress={() => downloadAttachment(state.url!, title)}
        >
          <Text variant="bodySmall" tone="primary">
            Open / download file
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function formatProfileName(author: string, profile?: ProfileData): string {
  const displayName = profile?.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  const username = profile?.username?.trim();
  if (username) {
    return `@${username}`;
  }
  return shortPeerId(author);
}

function shortPeerId(peerId: string): string {
  return peerId.length <= 18 ? peerId : `${peerId.slice(0, 8)}...${peerId.slice(-6)}`;
}

function downloadAttachment(url: string, name: string): void {
  const webDocument = (globalThis as unknown as { document?: WebDownloadDocument }).document;
  if (!webDocument) {
    return;
  }
  const link = webDocument.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  link.target = '_blank';
  link.click();
}

type WebDownloadDocument = {
  createElement: (tagName: 'a') => {
    href: string;
    download: string;
    rel: string;
    target: string;
    click: () => void;
  };
};

async function ensureAttachmentMetadata(input: {
  attachment: PostMediaAttachment;
  author: string;
  createdAt: number;
  updatedAt: number;
  signature: string;
}): Promise<void> {
  const { attachment, author, createdAt, updatedAt, signature } = input;
  if (attachment.chunks.length === 0) {
    return;
  }
  const repository = appService.getMediaObjectRepository();
  const existing = await repository.getById(attachment.id);
  if (existing) {
    return;
  }
  await repository.create({
    id: attachment.id,
    author,
    createdAt,
    updatedAt,
    signature,
    version: '1.0',
    type: attachment.type,
    mime: attachment.mime,
    size: attachment.size,
    hash: attachment.hash,
    chunks: attachment.chunks,
  });
}

type WebBlobConstructor = new (parts: ArrayBuffer[], options: { type: string }) => unknown;

function getWebMediaGlobals(): {
  Blob: WebBlobConstructor;
  createObjectURL: (value: unknown) => string;
  revokeObjectURL: (url: string) => void;
} | null {
  const candidate = globalThis as unknown as {
    Blob?: WebBlobConstructor;
    URL?: {
      createObjectURL?: (value: unknown) => string;
      revokeObjectURL?: (url: string) => void;
    };
  };

  if (
    Platform.OS !== 'web' ||
    !candidate.Blob ||
    !candidate.URL?.createObjectURL ||
    !candidate.URL.revokeObjectURL
  ) {
    return null;
  }

  return {
    Blob: candidate.Blob,
    createObjectURL: candidate.URL.createObjectURL.bind(candidate.URL),
    revokeObjectURL: candidate.URL.revokeObjectURL.bind(candidate.URL),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function MediaStatusBadge({
  status,
}: {
  status: MediaDownloadState['status'] | 'loading' | 'missing' | 'unsupported' | 'retrying';
}) {
  return (
    <View style={[styles.mediaStatusBadge, getMediaStatusBadgeStyle(status)]}>
      <Text variant="caption" tone="primary">
        {formatMediaStatus(status)}
      </Text>
    </View>
  );
}

function toMediaBadgeStatus(
  status: 'loading' | 'ready' | 'missing' | 'unsupported' | 'retrying',
): MediaDownloadState['status'] | 'loading' | 'missing' | 'unsupported' | 'retrying' {
  return status === 'ready' ? 'available' : status;
}

function getMediaStatusBadgeStyle(
  status: MediaDownloadState['status'] | 'loading' | 'missing' | 'unsupported' | 'retrying',
) {
  if (status === 'available') {
    return styles.mediaStatusAvailable;
  }
  if (status === 'queued' || status === 'downloading' || status === 'retrying') {
    return styles.mediaStatusActive;
  }
  if (status === 'failed' || status === 'partial' || status === 'missing') {
    return styles.mediaStatusWarning;
  }
  return styles.mediaStatusMuted;
}

function formatMediaStatus(
  status: MediaDownloadState['status'] | 'loading' | 'missing' | 'unsupported' | 'retrying',
): string {
  switch (status) {
    case 'available':
      return 'Available';
    case 'queued':
      return 'Queued';
    case 'downloading':
      return 'Downloading';
    case 'partial':
      return 'Partial';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'retrying':
      return 'Retrying';
    case 'unsupported':
      return 'Unsupported';
    case 'loading':
      return 'Checking';
    case 'idle':
    case 'missing':
    default:
      return 'Missing';
  }
}

function formatMediaAvailabilityMessage(
  previewStatus: 'loading' | 'ready' | 'missing' | 'unsupported' | 'retrying',
  download: MediaDownloadState | null,
  attachment: PostMediaAttachment,
): string {
  if (previewStatus === 'unsupported') {
    return 'Preview is available only in the web runtime.';
  }
  if (previewStatus === 'retrying') {
    return 'Retrying media download from connected peers.';
  }
  if (!download) {
    return attachment.type === 'document'
      ? 'File metadata is available. Download it when needed.'
      : 'Media chunks are not available locally yet.';
  }
  if (download.status === 'queued') {
    return 'Waiting for an available peer to serve this media.';
  }
  if (download.status === 'downloading') {
    return 'Downloading and validating chunks from peers.';
  }
  if (download.status === 'partial') {
    return download.error ?? 'Some chunks arrived, but the file is not complete yet.';
  }
  if (download.status === 'failed') {
    return download.error ?? 'Download failed. Retry when peers are connected.';
  }
  if (download.status === 'cancelled') {
    return 'Download cancelled. You can restart it later.';
  }
  return 'Media is waiting for download.';
}

function getDownloadProgressPercentage(download: MediaDownloadState): number {
  if (download.totalChunks <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((download.downloadedChunks / download.totalChunks) * 100));
}

function formatDownloadProgress(
  download: MediaDownloadState,
  attachment: PostMediaAttachment,
): string {
  if (download.totalChunks === 0) {
    return attachment.chunks.length > 0
      ? `0/${attachment.chunks.length} chunks - ${download.candidatePeers.length} peer(s)`
      : 'This post did not include chunk metadata for this media.';
  }
  return `${download.downloadedChunks}/${download.totalChunks} chunks - ${download.candidatePeers.length} peer(s)`;
}

function shouldAutoDownloadAttachment(attachment: PostMediaAttachment): boolean {
  if (attachment.type === 'document') {
    return false;
  }
  return attachment.size <= 25 * 1024 * 1024;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

const videoPreviewStyle: React.CSSProperties = {
  backgroundColor: '#050509',
  borderRadius: 8,
  maxHeight: 420,
  width: '100%',
};

const audioPreviewStyle: React.CSSProperties = {
  width: '100%',
};

const styles = StyleSheet.create({
  content: {
    gap: 16,
    padding: 16,
  },
  header: {
    gap: 16,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
  },
  cardContent: {
    gap: 12,
  },
  comment: {
    borderLeftColor: '#2C2C2E',
    borderLeftWidth: 2,
    gap: 4,
    paddingLeft: 10,
  },
  editBlock: {
    gap: 10,
  },
  postHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  postManageActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'flex-end',
  },
  mediaList: {
    gap: 10,
  },
  mediaCard: {
    backgroundColor: '#0A0A0F',
    borderColor: '#2C2C2E',
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
    padding: 10,
  },
  mediaHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
  },
  mediaTitleBlock: {
    flex: 1,
    gap: 4,
  },
  mediaStatusBadge: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  mediaStatusActive: {
    backgroundColor: 'rgba(10, 132, 255, 0.22)',
  },
  mediaStatusAvailable: {
    backgroundColor: 'rgba(52, 199, 89, 0.22)',
  },
  mediaStatusMuted: {
    backgroundColor: 'rgba(142, 142, 147, 0.18)',
  },
  mediaStatusWarning: {
    backgroundColor: 'rgba(255, 204, 0, 0.22)',
  },
  mediaProgressBlock: {
    gap: 6,
  },
  mediaProgressTrack: {
    backgroundColor: '#1C1C1E',
    borderRadius: 6,
    height: 8,
    overflow: 'hidden',
  },
  mediaProgressFill: {
    backgroundColor: '#0A84FF',
    height: '100%',
  },
  imagePreview: {
    backgroundColor: '#050509',
    borderRadius: 8,
    height: 420,
    width: '100%',
  },
  imagePreviewButton: {
    backgroundColor: '#050509',
    borderRadius: 8,
    overflow: 'hidden',
    width: '100%',
  },
  imageViewerBody: {
    flex: 1,
    padding: 16,
  },
  imageViewerClose: {
    borderColor: '#2C2C2E',
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  imageViewerHeader: {
    alignItems: 'center',
    borderBottomColor: '#1C1C1E',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    padding: 16,
  },
  imageViewerImage: {
    flex: 1,
    width: '100%',
  },
  imageViewerOverlay: {
    backgroundColor: '#000000',
    flex: 1,
  },
  downloadButton: {
    alignItems: 'center',
    borderColor: '#2C2C2E',
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    padding: 12,
  },
  mediaActions: {
    flexDirection: 'row',
    gap: 8,
  },
});
