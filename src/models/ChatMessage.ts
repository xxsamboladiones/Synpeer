import type { PeerId } from '@/network/NetworkTypes';

import type { BaseModel } from './BaseModel';

export interface ChatMessageData extends BaseModel {
  id: string;
  author: PeerId;
  createdAt: number;
  updatedAt: number;
  signature: string;
  version: string;
  conversationId: string;
  senderId: PeerId;
  recipientId: PeerId;
  text: string;
  contentHash: string;
  deliveredAt?: number;
  readAt?: number;
  relayOnly?: boolean;
  deleted: boolean;
}

export function getConversationId(left: PeerId, right: PeerId): string {
  return [left, right].sort().join(':');
}
