import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';

import { Button, Card, Screen, Text } from '@/components/ui';
import { AppError } from '@/errors/AppError';
import { useApplicationEvents, useConnectivitySnapshot } from '@/hooks/useApplicationEvents';
import type { ChatMessageData } from '@/models/ChatMessage';
import type { FollowData } from '@/models/Follow';
import type { PeerId } from '@/network/NetworkTypes';
import { createLogger } from '@/observability/Logger';
import { appService } from '@/services/AppService';
import type {
  ApplicationConnectivitySnapshot,
  ApplicationEvent,
} from '@/services/events/ApplicationEventService';

const logger = createLogger('ChatScreen');

interface ChatPeer {
  peerId: PeerId;
  relation: 'following' | 'follower' | 'mutual';
}

export default function ChatScreen() {
  const [localPeerId, setLocalPeerId] = useState<PeerId | null>(null);
  const [peers, setPeers] = useState<ChatPeer[]>([]);
  const [selectedPeerId, setSelectedPeerId] = useState<PeerId | null>(null);
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deliveryStatus, setDeliveryStatus] = useState<string | null>(null);
  const selectedPeerRef = useRef<PeerId | null>(null);
  const connectivity = useConnectivitySnapshot();

  const selectedPeer = useMemo(
    () => peers.find((peer) => peer.peerId === selectedPeerId) ?? null,
    [peers, selectedPeerId],
  );

  useEffect(() => {
    selectedPeerRef.current = selectedPeerId;
  }, [selectedPeerId]);

  const loadMessages = useCallback(async (localId: PeerId, peerId: PeerId) => {
    const socialQuery = appService.getSocialQueryService();
    setMessages(await socialQuery.getChatMessages(localId, peerId, 200, 0));
    void appService
      .getSocialApplicationService()
      .markConversationRead(peerId)
      .catch((caught) => {
        logger.warn('chat_read_receipt_failed', {
          peerId,
          message: caught instanceof Error ? caught.message : 'unknown',
        });
      });
  }, []);

  const loadChat = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await appService.initialize();
      const identity = appService.getLocalPeerId();
      if (!identity) {
        setLocalPeerId(null);
        setPeers([]);
        setMessages([]);
        return;
      }

      const followRepository = appService.getFollowRepository();
      const [following, followers] = await Promise.all([
        followRepository.getFollowing(identity, 200, 0),
        followRepository.getFollowers(identity, 200, 0),
      ]);
      const chatPeers = buildChatPeers(identity, following, followers);
      const currentSelected = selectedPeerRef.current;
      const nextSelected =
        currentSelected && chatPeers.some((peer) => peer.peerId === currentSelected)
          ? currentSelected
          : (chatPeers[0]?.peerId ?? null);

      setLocalPeerId(identity);
      setPeers(chatPeers);
      setSelectedPeerId(nextSelected);
      if (nextSelected) {
        await loadMessages(identity, nextSelected);
      } else {
        setMessages([]);
      }
    } catch (caught) {
      logger.error('chat_load_failed', caught);
      setError(caught instanceof Error ? caught.message : 'Nao foi possivel carregar o chat');
    } finally {
      setLoading(false);
    }
  }, [loadMessages]);
  const refreshChatFromEvent = useCallback(
    async (event: ApplicationEvent) => {
      const localId = appService.getLocalPeerId();
      const selected = selectedPeerRef.current;
      if (
        localId &&
        selected &&
        (event.type === 'application.delivery.changed' ||
          (event.type === 'application.data.changed' && event.entity === 'chat'))
      ) {
        await loadMessages(localId, selected);
        return;
      }
      await loadChat();
    },
    [loadChat, loadMessages],
  );

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => {
      void loadChat();
    }, 0);
    return () => {
      globalThis.clearTimeout(timeout);
    };
  }, [loadChat]);

  useApplicationEvents(['chat'], refreshChatFromEvent, { coalesceMs: 60 });

  async function selectPeer(peerId: PeerId) {
    selectedPeerRef.current = peerId;
    setSelectedPeerId(peerId);
    if (localPeerId) {
      await loadMessages(localPeerId, peerId);
    }
  }

  async function sendMessage() {
    if (!selectedPeerId) {
      setError('Selecione um seguidor antes de enviar.');
      return;
    }
    const text = draft.trim();
    if (!text) {
      setError('Escreva uma mensagem antes de enviar.');
      return;
    }

    setSending(true);
    setError(null);
    setDeliveryStatus(null);
    try {
      await appService.initialize();
      const result = await appService.getSocialApplicationService().createChatMessage({
        recipientId: selectedPeerId,
        text,
      });
      setDraft('');
      setDeliveryStatus(formatDeliveryStatus(result.replication));
    } catch (caught) {
      logger.error('chat_send_failed', caught);
      setError(
        caught instanceof AppError
          ? caught.safeMessage
          : caught instanceof Error
            ? caught.message
            : 'Nao foi possivel enviar a mensagem',
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View>
            <Text variant="heading" tone="primary">
              Chat
            </Text>
            <Text variant="bodySmall" tone="secondary">
              {formatChatConnectivity(connectivity)}
            </Text>
          </View>
          <Button label="Feed" variant="ghost" onPress={() => router.push('/feed')} />
        </View>

        {!localPeerId && !loading ? (
          <Card>
            <View style={styles.cardContent}>
              <Text variant="body" tone="primary">
                Crie uma identidade para usar o chat.
              </Text>
              <Button label="Criar identidade" onPress={() => router.push('/identity/create')} />
            </View>
          </Card>
        ) : null}

        {localPeerId && peers.length === 0 && !loading ? (
          <Card>
            <View style={styles.cardContent}>
              <Text variant="body" tone="primary">
                Nenhum seguidor disponivel para conversa.
              </Text>
              <Text variant="bodySmall" tone="secondary">
                Siga um peer ou receba um follow para habilitar mensagens diretas.
              </Text>
            </View>
          </Card>
        ) : null}

        {error ? (
          <Text variant="bodySmall" tone="danger">
            {error}
          </Text>
        ) : null}

        {loading ? (
          <Text variant="body" tone="secondary">
            Carregando chat...
          </Text>
        ) : null}

        {localPeerId && peers.length > 0 ? (
          <View style={styles.layout}>
            <Card style={styles.peerPanel}>
              <View style={styles.cardContent}>
                <Text variant="bodySmall" tone="secondary">
                  Conversas
                </Text>
                {peers.map((peer) => (
                  <TouchableOpacity
                    key={peer.peerId}
                    testID={`chat-peer-${peer.peerId}`}
                    style={[
                      styles.peerButton,
                      peer.peerId === selectedPeerId && styles.peerButtonActive,
                    ]}
                    onPress={() => {
                      void selectPeer(peer.peerId);
                    }}
                  >
                    <Text variant="bodySmall" tone="primary">
                      {shortPeer(peer.peerId)}
                    </Text>
                    <Text variant="caption" tone="secondary">
                      {peer.relation}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </Card>

            <Card style={styles.chatPanel}>
              <View style={styles.cardContent}>
                <Text variant="bodySmall" tone="secondary">
                  {selectedPeer ? shortPeer(selectedPeer.peerId) : 'Selecione uma conversa'}
                </Text>
                <View style={styles.messageList}>
                  {messages.length === 0 ? (
                    <Text variant="bodySmall" tone="secondary">
                      Nenhuma mensagem nesta conversa.
                    </Text>
                  ) : null}
                  {messages.map((message) => {
                    const own = message.senderId === localPeerId;
                    return (
                      <View
                        key={message.id}
                        testID={`chat-message-${message.id}`}
                        style={[styles.messageBubble, own ? styles.ownBubble : styles.remoteBubble]}
                      >
                        <Text variant="bodySmall" tone="primary">
                          {message.text}
                        </Text>
                        <Text variant="caption" tone="secondary">
                          {own
                            ? `Voce - ${formatMessageStatus(message)}`
                            : shortPeer(message.senderId)}
                        </Text>
                      </View>
                    );
                  })}
                </View>
                <TextInput
                  testID="chat-message-input"
                  style={styles.input}
                  value={draft}
                  onChangeText={setDraft}
                  placeholder="Digite uma mensagem"
                  placeholderTextColor="#8f93a8"
                  multiline
                />
                {deliveryStatus ? (
                  <Text variant="caption" tone="secondary">
                    {deliveryStatus}
                  </Text>
                ) : null}
                <Button
                  testID="chat-send"
                  label={sending ? 'Enviando...' : 'Enviar'}
                  disabled={sending || !selectedPeerId}
                  onPress={sendMessage}
                />
              </View>
            </Card>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function formatChatConnectivity(snapshot: ApplicationConnectivitySnapshot): string {
  if (snapshot.status === 'syncing') {
    return 'Sincronizando mensagens';
  }
  if (snapshot.connectedPeers > 0) {
    return `${snapshot.connectedPeers} peer(s) conectado(s) - entrega P2P ativa`;
  }
  if (snapshot.status === 'reconnecting') {
    return 'Reconectando - mensagens permanecem na fila local';
  }
  if (snapshot.status === 'connecting' || snapshot.status === 'handshaking') {
    return 'Estabelecendo sessao P2P';
  }
  return 'Offline - mensagens serao entregues quando houver conexao';
}

function buildChatPeers(
  localPeerId: PeerId,
  following: FollowData[],
  followers: FollowData[],
): ChatPeer[] {
  const map = new Map<PeerId, ChatPeer>();
  for (const follow of following) {
    if (follow.followingId === localPeerId) {
      continue;
    }
    map.set(follow.followingId, { peerId: follow.followingId, relation: 'following' });
  }
  for (const follow of followers) {
    if (follow.followerId === localPeerId) {
      continue;
    }
    const existing = map.get(follow.followerId);
    map.set(follow.followerId, {
      peerId: follow.followerId,
      relation: existing ? 'mutual' : 'follower',
    });
  }
  return Array.from(map.values()).sort((left, right) => left.peerId.localeCompare(right.peerId));
}

function shortPeer(peerId: string): string {
  return peerId.length <= 16 ? peerId : `${peerId.slice(0, 8)}...${peerId.slice(-6)}`;
}

function formatDeliveryStatus(replication: {
  attemptedPeers: number;
  successfulPeers: string[];
  failedPeers: Array<{ peerId: string }>;
}): string {
  if (replication.attemptedPeers === 0) {
    return 'Mensagem salva. Aguardando conexao com peer confiavel para sincronizar.';
  }
  if (replication.failedPeers.length > 0 && replication.successfulPeers.length === 0) {
    return 'Mensagem salva localmente, mas a replicacao falhou. O sync tentara novamente.';
  }
  return 'Mensagem encaminhada pela rede. Aguardando confirmacao do destinatario.';
}

function formatMessageStatus(message: ChatMessageData): string {
  if (message.readAt) {
    return 'lida';
  }
  if (message.deliveredAt) {
    return 'entregue';
  }
  return 'aguardando entrega';
}

const styles = StyleSheet.create({
  content: {
    gap: 16,
    padding: 16,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  layout: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
  },
  peerPanel: {
    flexBasis: 260,
    flexGrow: 1,
  },
  chatPanel: {
    flexBasis: 420,
    flexGrow: 3,
  },
  cardContent: {
    gap: 12,
  },
  peerButton: {
    borderColor: '#2b2d42',
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
    padding: 12,
  },
  peerButtonActive: {
    backgroundColor: '#17223d',
    borderColor: '#2d7dff',
  },
  messageList: {
    gap: 10,
    minHeight: 260,
  },
  messageBubble: {
    borderRadius: 8,
    gap: 4,
    maxWidth: '78%',
    padding: 12,
  },
  ownBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#123b69',
  },
  remoteBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#202235',
  },
  input: {
    borderColor: '#2b2d42',
    borderRadius: 10,
    borderWidth: 1,
    color: '#f6f7fb',
    minHeight: 72,
    padding: 12,
  },
});
