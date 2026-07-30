import { router } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';

import { Button, Text } from '@/components/ui';
import { useApplicationEvents } from '@/hooks/useApplicationEvents';
import type { PeerId } from '@/network/NetworkTypes';
import { createLogger } from '@/observability/Logger';
import { appService } from '@/services/AppService';
import {
  hideSocialNotifications,
  loadSocialNotifications,
  markSocialNotificationsRead,
  type SocialNotificationItem,
} from '@/services/notifications/SocialNotificationInbox';

const logger = createLogger('NotificationsScreen');

export default function NotificationsScreen() {
  const [localPeerId, setLocalPeerId] = useState<PeerId | null>(null);
  const [notifications, setNotifications] = useState<SocialNotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionNotificationId, setActionNotificationId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadInbox = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) {
      setLoading(true);
    }
    setErrorMessage(null);
    try {
      await appService.initialize();
      const identity = appService.getLocalPeerId();
      setLocalPeerId(identity);
      setNotifications(await loadSocialNotifications());
    } catch (error) {
      logger.error('notifications_load_failed', error);
      setErrorMessage('Nao foi possivel carregar notificacoes.');
    } finally {
      if (!options.silent) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => {
      void loadInbox();
    }, 0);
    return () => {
      globalThis.clearTimeout(timeout);
    };
  }, [loadInbox]);

  const refreshInboxFromEvent = useCallback(() => loadInbox({ silent: true }), [loadInbox]);
  useApplicationEvents(['notifications'], refreshInboxFromEvent, { coalesceMs: 75 });

  function handleMarkAllRead() {
    if (!localPeerId) {
      return;
    }
    markSocialNotificationsRead(
      localPeerId,
      notifications.map((notification) => notification.id),
    );
    void loadInbox({ silent: true });
  }

  function handleClearAll() {
    if (!localPeerId) {
      return;
    }
    hideSocialNotifications(
      localPeerId,
      notifications.map((notification) => notification.id),
    );
    void loadInbox({ silent: true });
  }

  function openNotification(notification: SocialNotificationItem) {
    if (localPeerId) {
      markSocialNotificationsRead(localPeerId, [notification.id]);
    }
    if (notification.targetRoute === '/profile/[author]') {
      router.push({
        pathname: '/profile/[author]',
        params: notification.targetParams ?? { author: notification.actorId },
      });
      return;
    }
    router.push(notification.targetRoute);
  }

  async function followBack(notification: SocialNotificationItem) {
    if (!localPeerId || !notification.followBackPeerId || notification.followingBack) {
      return;
    }
    setActionNotificationId(notification.id);
    setErrorMessage(null);
    try {
      await appService.getSocialApplicationService().createFollow({
        followingId: notification.followBackPeerId,
      });
      markSocialNotificationsRead(localPeerId, [notification.id]);
      await loadInbox({ silent: true });
    } catch (error) {
      logger.error('notification_follow_back_failed', error, {
        followerId: notification.followBackPeerId,
      });
      setErrorMessage('Nao foi possivel seguir de volta.');
    } finally {
      setActionNotificationId(null);
    }
  }

  const unreadCount = notifications.filter((notification) => !notification.read).length;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Notifications</Text>
          <Text style={styles.subtitle}>
            {localPeerId
              ? `${unreadCount} nova(s) em comentarios, curtidas, mensagens e sync`
              : 'Crie uma identidade para receber eventos'}
          </Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity onPress={handleMarkAllRead} disabled={notifications.length === 0}>
            <Text style={styles.headerAction}>Marcar lidas</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleClearAll} disabled={notifications.length === 0}>
            <Text style={[styles.headerAction, styles.headerActionDanger]}>Limpar</Text>
          </TouchableOpacity>
        </View>
      </View>

      {errorMessage ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>Carregando notificacoes...</Text>
        </View>
      ) : null}

      {!loading && notifications.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>Nenhuma notificacao</Text>
          <Text style={styles.emptySubtext}>
            Novos follows, comentarios, curtidas e mensagens vao aparecer aqui.
          </Text>
        </View>
      ) : (
        notifications.map((notification) => (
          <NotificationCard
            key={notification.id}
            notification={notification}
            busy={actionNotificationId === notification.id}
            onOpen={() => openNotification(notification)}
            onFollowBack={() => {
              void followBack(notification);
            }}
          />
        ))
      )}
    </ScrollView>
  );
}

function NotificationCard({
  notification,
  busy,
  onOpen,
  onFollowBack,
}: {
  notification: SocialNotificationItem;
  busy: boolean;
  onOpen: () => void;
  onFollowBack: () => void;
}) {
  return (
    <View style={[styles.notificationCard, !notification.read && styles.notificationCardUnread]}>
      <View style={styles.notificationHeader}>
        <View style={[styles.notificationBadge, getBadgeStyle(notification.type)]}>
          <Text style={styles.notificationBadgeText}>{getBadgeLabel(notification.type)}</Text>
        </View>
        <View style={styles.notificationContent}>
          <Text style={styles.notificationTitle}>{notification.title}</Text>
          <Text style={styles.notificationMessage}>{notification.message}</Text>
        </View>
        {!notification.read && <View style={styles.unreadDot} />}
      </View>
      <Text style={styles.notificationTime}>{formatTimestamp(notification.timestamp)}</Text>
      <View style={styles.notificationActions}>
        <Button label={notification.primaryAction} variant="ghost" onPress={onOpen} />
        {notification.followBackPeerId ? (
          <Button
            label={
              notification.followingBack ? 'Seguindo' : busy ? 'Seguindo...' : 'Seguir de volta'
            }
            variant={notification.followingBack ? 'secondary' : 'primary'}
            disabled={notification.followingBack || busy}
            onPress={onFollowBack}
          />
        ) : null}
      </View>
    </View>
  );
}

function getBadgeLabel(type: SocialNotificationItem['type']): string {
  switch (type) {
    case 'comment':
      return 'C';
    case 'reaction':
      return 'L';
    case 'chat':
      return 'M';
    case 'post':
      return 'P';
    case 'follower':
    default:
      return 'F';
  }
}

function getBadgeStyle(type: SocialNotificationItem['type']) {
  switch (type) {
    case 'comment':
      return styles.badgeComment;
    case 'reaction':
      return styles.badgeReaction;
    case 'chat':
      return styles.badgeChat;
    case 'post':
      return styles.badgePost;
    case 'follower':
    default:
      return styles.badgeFollow;
  }
}

function formatTimestamp(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) {
    return 'Agora';
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  if (hours < 24) {
    return `${hours} h`;
  }
  return `${days} d`;
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
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 20,
    gap: 16,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  subtitle: {
    color: '#8E8E93',
    fontSize: 14,
    marginTop: 6,
  },
  headerActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
  },
  headerAction: {
    fontSize: 14,
    color: '#007AFF',
  },
  headerActionDanger: {
    color: '#FF3B30',
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
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  emptyText: {
    fontSize: 18,
    color: '#FFFFFF',
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#8E8E93',
  },
  notificationCard: {
    backgroundColor: '#0A0A0F',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#1C1C1E',
  },
  notificationCardUnread: {
    borderColor: '#007AFF',
  },
  notificationHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  notificationBadge: {
    alignItems: 'center',
    borderRadius: 14,
    height: 28,
    justifyContent: 'center',
    marginRight: 12,
    width: 28,
  },
  badgeFollow: {
    backgroundColor: '#123B69',
  },
  badgeComment: {
    backgroundColor: '#234124',
  },
  badgeReaction: {
    backgroundColor: '#4D3B10',
  },
  badgeChat: {
    backgroundColor: '#3B2356',
  },
  badgePost: {
    backgroundColor: '#3B2B2B',
  },
  notificationBadgeText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  notificationContent: {
    flex: 1,
  },
  notificationTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 4,
  },
  notificationMessage: {
    fontSize: 14,
    color: '#8E8E93',
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#007AFF',
    marginLeft: 8,
  },
  notificationTime: {
    fontSize: 12,
    color: '#8E8E93',
    marginTop: 8,
  },
  notificationActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 12,
  },
});
