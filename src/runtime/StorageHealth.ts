import type { MediaChunkData } from '@/models/MediaChunk';
import type { MediaObjectData, MediaType } from '@/models/MediaObject';
import type { PostData } from '@/models/Post';

export interface StorageHealthSnapshot {
  distributedStorageBytes: number;
  mediaChunkBytes: number;
  totalUsedBytes: number;
  totalKeys: number;
  replicatedKeys: number;
  mediaObjects: number;
  completeMediaObjects: number;
  protectedMediaObjects: number;
  orphanMediaObjects: number;
  chunks: number;
  orphanChunks: number;
  activeDownloads: number;
  averageChunkBytes: number;
  mediaByType: Record<MediaType, number>;
}

export interface StorageHealthInput {
  distributedStorageBytes?: number;
  totalKeys?: number;
  replicatedKeys?: number;
  mediaObjects: MediaObjectData[];
  chunks: MediaChunkData[];
  posts: PostData[];
  activeDownloads: number;
}

export function createStorageHealthSnapshot(input: StorageHealthInput): StorageHealthSnapshot {
  const mediaObjectIds = new Set(input.mediaObjects.map((mediaObject) => mediaObject.id));
  const protectedIds = new Set(
    input.posts.flatMap((post) => (post.mediaAttachments ?? []).map((attachment) => attachment.id)),
  );
  const mediaChunkBytes = input.chunks.reduce((sum, chunk) => sum + chunk.size, 0);
  const completeMediaObjects = input.mediaObjects.filter((mediaObject) =>
    isMediaObjectComplete(mediaObject, input.chunks),
  ).length;
  const orphanMediaObjects = input.mediaObjects.filter(
    (mediaObject) => !protectedIds.has(mediaObject.id),
  ).length;
  const orphanChunks = input.chunks.filter(
    (chunk) => !mediaObjectIds.has(chunk.mediaObjectId),
  ).length;
  const mediaByType: Record<MediaType, number> = {
    video: 0,
    audio: 0,
    image: 0,
    document: 0,
  };

  for (const mediaObject of input.mediaObjects) {
    mediaByType[mediaObject.type] += 1;
  }

  return {
    distributedStorageBytes: input.distributedStorageBytes ?? 0,
    mediaChunkBytes,
    totalUsedBytes: (input.distributedStorageBytes ?? 0) + mediaChunkBytes,
    totalKeys: input.totalKeys ?? 0,
    replicatedKeys: input.replicatedKeys ?? 0,
    mediaObjects: input.mediaObjects.length,
    completeMediaObjects,
    protectedMediaObjects: protectedIds.size,
    orphanMediaObjects,
    chunks: input.chunks.length,
    orphanChunks,
    activeDownloads: input.activeDownloads,
    averageChunkBytes:
      input.chunks.length > 0 ? Math.round(mediaChunkBytes / input.chunks.length) : 0,
    mediaByType,
  };
}

function isMediaObjectComplete(mediaObject: MediaObjectData, chunks: MediaChunkData[]): boolean {
  const localChunkIds = new Set(
    chunks.filter((chunk) => chunk.mediaObjectId === mediaObject.id).map((chunk) => chunk.id),
  );
  return mediaObject.chunks.every((chunkId) => localChunkIds.has(chunkId));
}
