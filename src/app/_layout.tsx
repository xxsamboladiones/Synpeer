import '@/styles/global.css';

import { Tabs } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { Text } from 'react-native';

import { useApplicationEvents } from '@/hooks/useApplicationEvents';
import {
  getUnreadSocialNotificationCount,
  subscribeSocialNotificationInbox,
} from '@/services/notifications/SocialNotificationInbox';
import { ThemeProvider } from '@/styles/theme';

const hiddenTabRoutes = [
  'index',
  'wallet',
  'network',
  'settings',
  'identity/create',
  'developer/consensus-dashboard',
  'developer/logs',
  'developer/network-monitor',
  'developer/protocol-version',
  'developer/social-inspector',
  'developer/storage-inspector',
  'profile/[author]',
] as const;

export default function RootLayout() {
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [unreadMessages, setUnreadMessages] = useState(0);

  const refreshUnreadNotifications = useCallback(async () => {
    try {
      const [all, messages] = await Promise.all([
        getUnreadSocialNotificationCount(),
        getUnreadSocialNotificationCount('chat'),
      ]);
      setUnreadNotifications(all);
      setUnreadMessages(messages);
    } catch {
      setUnreadNotifications(0);
      setUnreadMessages(0);
    }
  }, []);

  useEffect(() => {
    const unsubscribeInbox = subscribeSocialNotificationInbox(() => {
      void refreshUnreadNotifications();
    });
    const timeout = globalThis.setTimeout(() => {
      void refreshUnreadNotifications();
    }, 0);
    return () => {
      globalThis.clearTimeout(timeout);
      unsubscribeInbox();
    };
  }, [refreshUnreadNotifications]);
  useApplicationEvents(['notifications'], refreshUnreadNotifications, { coalesceMs: 75 });

  return (
    <ThemeProvider>
      <StatusBar style="light" />
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: '#007AFF',
          tabBarInactiveTintColor: '#8E8E93',
          tabBarStyle: {
            backgroundColor: '#0A0A0F',
            borderTopColor: '#1C1C1E',
            borderTopWidth: 1,
            height: 85,
            paddingBottom: 20,
            paddingTop: 10,
          },
        }}
      >
        <Tabs.Screen
          name="feed"
          options={{
            title: 'Feed',
            tabBarIcon: ({ color, size }) => <Text style={{ color, fontSize: size }}>🏠</Text>,
          }}
        />
        <Tabs.Screen
          name="chat"
          options={{
            title: 'Mensagens',
            tabBarBadge: unreadMessages > 0 ? unreadMessages : undefined,
            tabBarIcon: ({ color, size }) => <Text style={{ color, fontSize: size }}>M</Text>,
          }}
        />
        <Tabs.Screen
          name="discover"
          options={{
            title: 'Discover',
            tabBarIcon: ({ color, size }) => <Text style={{ color, fontSize: size }}>🔍</Text>,
          }}
        />
        <Tabs.Screen
          name="create"
          options={{
            title: 'Create',
            tabBarIcon: ({ color, size }) => <Text style={{ color, fontSize: size }}>➕</Text>,
          }}
        />
        <Tabs.Screen
          name="contribution"
          options={{
            title: 'Contribution',
            tabBarIcon: ({ color, size }) => <Text style={{ color, fontSize: size }}>📊</Text>,
          }}
        />
        <Tabs.Screen
          name="peers"
          options={{
            title: 'Peers',
            tabBarIcon: ({ color, size }) => <Text style={{ color, fontSize: size }}>P</Text>,
          }}
        />
        <Tabs.Screen
          name="notifications"
          options={{
            title: 'Alerts',
            tabBarBadge: unreadNotifications > 0 ? unreadNotifications : undefined,
            tabBarIcon: ({ color, size }) => <Text style={{ color, fontSize: size }}>N</Text>,
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            title: 'Profile',
            tabBarIcon: ({ color, size }) => <Text style={{ color, fontSize: size }}>👤</Text>,
          }}
        />
        {hiddenTabRoutes.map((route) => (
          <Tabs.Screen key={route} name={route} options={{ href: null }} />
        ))}
      </Tabs>
    </ThemeProvider>
  );
}
