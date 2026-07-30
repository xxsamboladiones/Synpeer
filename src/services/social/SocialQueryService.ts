import type { ChatMessageData } from '@/models/ChatMessage';
import { getConversationId } from '@/models/ChatMessage';
import type { PostData } from '@/models/Post';
import type { ProfileData } from '@/models/Profile';
import type { CommentData } from '@/models/Comment';
import type { PeerId } from '@/network/NetworkTypes';
import type { ChatMessageRepository } from '@/repositories/ChatMessageRepository';
import type { CommentRepository } from '@/repositories/CommentRepository';
import type { FollowRepository } from '@/repositories/FollowRepository';
import type { PostRepository } from '@/repositories/PostRepository';
import type { ProfileRepository } from '@/repositories/ProfileRepository';
import type { ReactionRepository } from '@/repositories/ReactionRepository';

export class SocialQueryService {
  constructor(
    private readonly posts: PostRepository,
    private readonly profiles: ProfileRepository,
    private readonly comments?: CommentRepository,
    private readonly reactions?: ReactionRepository,
    private readonly follows?: FollowRepository,
    private readonly chatMessages?: ChatMessageRepository,
  ) {}

  async getFeed(limit: number = 50, offset: number = 0): Promise<PostData[]> {
    return await this.posts.getAll(limit, offset);
  }

  async getAuthorPosts(
    author: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<PostData[]> {
    return await this.posts.getByAuthor(author, limit, offset);
  }

  async getPostCount(author?: string): Promise<number> {
    return await this.posts.getCount(author);
  }

  async getProfile(author: string): Promise<ProfileData | null> {
    return await this.profiles.getByAuthor(author);
  }

  async getProfiles(limit: number = 50, offset: number = 0): Promise<ProfileData[]> {
    return await this.profiles.getAll(limit, offset);
  }

  async getProfileCount(): Promise<number> {
    return await this.profiles.getCount();
  }

  async getCommentCount(): Promise<number | null> {
    return this.comments ? await this.comments.getCount() : null;
  }

  async getReactionCount(): Promise<number | null> {
    return this.reactions ? await this.reactions.getCount() : null;
  }

  async getFollowCount(): Promise<number | null> {
    return this.follows ? await this.follows.getCount() : null;
  }

  async getChatCount(): Promise<number | null> {
    return this.chatMessages ? await this.chatMessages.getCount() : null;
  }

  async getChatMessages(
    peerA: string,
    peerB: string,
    limit: number = 100,
    offset: number = 0,
  ): Promise<ChatMessageData[]> {
    if (!this.chatMessages) {
      return [];
    }
    return await this.chatMessages.getConversation(
      getConversationId(peerA as PeerId, peerB as PeerId),
      limit,
      offset,
    );
  }

  async getCommentsForPost(postId: string, limit: number = 50): Promise<CommentData[]> {
    return this.comments ? await this.comments.getByPostId(postId, limit, 0) : [];
  }

  async getCommentCountForPost(postId: string): Promise<number> {
    return this.comments ? await this.comments.getCountByPost(postId) : 0;
  }

  async getReactionCountForPost(postId: string): Promise<number> {
    return this.reactions ? await this.reactions.getCountByPost(postId) : 0;
  }

  async hasReacted(author: string, postId: string): Promise<boolean> {
    return this.reactions ? await this.reactions.hasReacted(author, postId) : false;
  }

  async getFollowerCount(author: string): Promise<number> {
    return this.follows ? await this.follows.getFollowerCount(author) : 0;
  }

  async getFollowingCount(author: string): Promise<number> {
    return this.follows ? await this.follows.getFollowingCount(author) : 0;
  }

  async isFollowing(followerId: string, followingId: string): Promise<boolean> {
    return this.follows ? await this.follows.isFollowing(followerId, followingId) : false;
  }
}
