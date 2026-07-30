import type { PeerId } from '@/network/NetworkTypes';
import { appService } from '@/services/AppService';
import {
  buildSocialNotifications,
  type SocialNotificationItem,
  type SocialNotificationType,
} from '@/services/notifications/SocialNotificationModel';
import { localStorageService } from '@/services/storage/mmkvStorage';

const NOTIFICATION_STATE_KEY_PREFIX = 'synpeer:socialNotifications:v1:';
const LEGACY_NOTIFICATION_STATE_KEY_PREFIX = 'insta99:socialNotifications:v1:';
const inboxHandlers = new Set<() => void>();

export { buildSocialNotifications, type SocialNotificationItem };

interface NotificationState {
  readIds: string[];
  hiddenIds: string[];
}

export async function loadSocialNotifications(): Promise<SocialNotificationItem[]> {
  await appService.initialize();
  const localPeerId = appService.getLocalPeerId();
  if (!localPeerId) {
    return [];
  }

  const state = readNotificationState(localPeerId);
  const [ownPosts, followers, following, comments, reactions, chatMessages, feedPosts] =
    await Promise.all([
      appService.getPostRepository().getByAuthor(localPeerId, 1000, 0),
      appService.getFollowRepository().getFollowers(localPeerId, 500, 0),
      appService.getFollowRepository().getFollowing(localPeerId, 500, 0),
      appService.getCommentRepository().getAll(1000, 0),
      appService.getReactionRepository().getAll(1000, 0),
      appService.getChatMessageRepository().getAll(1000, 0),
      appService.getPostRepository().getAll(1000, 0),
    ]);

  return buildSocialNotifications({
    localPeerId,
    ownPosts,
    followers,
    following,
    comments,
    reactions,
    chatMessages,
    remotePosts: feedPosts.filter((post) => post.author !== localPeerId),
    readIds: new Set(state.readIds),
    hiddenIds: new Set(state.hiddenIds),
  });
}

export async function getUnreadSocialNotificationCount(
  type?: SocialNotificationType,
): Promise<number> {
  const notifications = await loadSocialNotifications();
  return notifications.filter(
    (notification) => !notification.read && (!type || notification.type === type),
  ).length;
}

export function markSocialNotificationsRead(localPeerId: PeerId, ids: readonly string[]): void {
  const state = readNotificationState(localPeerId);
  writeNotificationState(localPeerId, {
    ...state,
    readIds: Array.from(new Set([...state.readIds, ...ids])).sort(),
  });
  emitInboxChanged();
}

export function hideSocialNotifications(localPeerId: PeerId, ids: readonly string[]): void {
  const state = readNotificationState(localPeerId);
  writeNotificationState(localPeerId, {
    readIds: Array.from(new Set([...state.readIds, ...ids])).sort(),
    hiddenIds: Array.from(new Set([...state.hiddenIds, ...ids])).sort(),
  });
  emitInboxChanged();
}

export function subscribeSocialNotificationInbox(handler: () => void): () => void {
  inboxHandlers.add(handler);
  return () => {
    inboxHandlers.delete(handler);
  };
}

function readNotificationState(peerId: PeerId): NotificationState {
  const currentKey = `${NOTIFICATION_STATE_KEY_PREFIX}${peerId}`;
  const state =
    localStorageService.getJson<Partial<NotificationState>>(currentKey) ??
    localStorageService.getJson<Partial<NotificationState>>(
      `${LEGACY_NOTIFICATION_STATE_KEY_PREFIX}${peerId}`,
    );
  const normalized = {
    readIds: Array.isArray(state?.readIds)
      ? state.readIds.filter((id): id is string => typeof id === 'string')
      : [],
    hiddenIds: Array.isArray(state?.hiddenIds)
      ? state.hiddenIds.filter((id): id is string => typeof id === 'string')
      : [],
  };
  if (state) {
    localStorageService.setJson(currentKey, normalized);
  }
  return normalized;
}

function writeNotificationState(peerId: PeerId, state: NotificationState): void {
  localStorageService.setJson(`${NOTIFICATION_STATE_KEY_PREFIX}${peerId}`, state);
}

function emitInboxChanged(): void {
  for (const handler of inboxHandlers) {
    handler();
  }
}
