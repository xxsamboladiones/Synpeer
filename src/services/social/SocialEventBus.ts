import { createLogger } from '@/observability/Logger';

export type SocialEvent =
  | {
      type: 'social.post.created';
      postId: string;
      author: string;
      origin: 'local';
      timestamp: number;
    }
  | {
      type: 'social.post.received';
      postId: string;
      author: string;
      peerId: string;
      timestamp: number;
    }
  | { type: 'social.post.persisted'; postId: string; origin: 'local' | 'remote'; timestamp: number }
  | {
      type: 'social.post.updated';
      postId: string;
      author: string;
      origin: 'local' | 'remote';
      peerId?: string;
      timestamp: number;
    }
  | {
      type: 'social.post.deleted';
      postId: string;
      author: string;
      origin: 'local' | 'remote';
      peerId?: string;
      timestamp: number;
    }
  | {
      type: 'social.post.replication.completed';
      postId: string;
      successfulPeers: string[];
      failedPeers: string[];
      timestamp: number;
    }
  | {
      type: 'social.comment.persisted';
      commentId: string;
      postId: string;
      origin: 'local' | 'remote';
      peerId?: string;
      timestamp: number;
    }
  | {
      type: 'social.reaction.persisted';
      reactionId: string;
      postId: string;
      origin: 'local' | 'remote';
      peerId?: string;
      timestamp: number;
    }
  | {
      type: 'social.follow.persisted';
      followId: string;
      followerId: string;
      followingId: string;
      deleted: boolean;
      origin: 'local' | 'remote';
      peerId?: string;
      timestamp: number;
    }
  | {
      type: 'social.chat.persisted';
      messageId: string;
      conversationId: string;
      peerId?: string;
      origin: 'local' | 'remote';
      timestamp: number;
    }
  | {
      type: 'social.chat.delivery.updated';
      messageId: string;
      conversationId: string;
      deliveredAt: number;
      peerId: string;
      timestamp: number;
    }
  | {
      type: 'social.chat.read.updated';
      messageId: string;
      conversationId: string;
      readAt: number;
      peerId: string;
      timestamp: number;
    }
  | {
      type: 'social.profile.updated';
      profileId: string;
      author: string;
      origin: 'local' | 'remote';
      timestamp: number;
    }
  | { type: 'social.sync.completed'; peerId: string; received: number; timestamp: number }
  | { type: 'social.sync.failed'; peerId: string; errorCode: string; timestamp: number }
  | {
      type: 'social.conflict.detected';
      entity: 'post' | 'profile' | 'comment' | 'reaction' | 'follow' | 'chat';
      entityId: string;
      peerId?: string;
      timestamp: number;
    };

export type SocialEventHandler = (event: SocialEvent) => void | Promise<void>;

export class SocialEventBus {
  private readonly logger = createLogger('social.events');
  private readonly handlers = new Set<SocialEventHandler>();

  emit(event: SocialEvent): void {
    for (const handler of this.handlers) {
      Promise.resolve(handler(event)).catch((error: unknown) => {
        this.logger.error('subscriber_failed', error, {
          eventType: event.type,
        });
      });
    }
  }

  subscribe(handler: SocialEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}
