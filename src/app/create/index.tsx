import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { createLogger } from '@/observability/Logger';
import { appService } from '@/services/AppService';
import type { PostMediaAttachment } from '@/models/Post';
import type { MediaType } from '@/models/MediaObject';

type SelectedAttachment = PostMediaAttachment & {
  name: string;
  previewUrl?: string;
};

type UploadQueueItem = {
  id: string;
  name: string;
  size: number;
  type: MediaType;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  message: string;
};

type WebFile = {
  name: string;
  type: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

type WebDocument = {
  createElement: (tagName: 'input') => {
    type: string;
    accept: string;
    multiple: boolean;
    files: ArrayLike<WebFile> | null;
    onchange: (() => void) | null;
    click: () => void;
  };
};

const logger = createLogger('CreateScreen');
const MAX_CHARS = 500;
const MAX_ATTACHMENTS = 8;
const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 1024 * 1024 * 1024;

export default function CreateScreen() {
  const [content, setContent] = useState('');
  const [charCount, setCharCount] = useState(0);
  const [isPosting, setIsPosting] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const [attachments, setAttachments] = useState<SelectedAttachment[]>([]);
  const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const attachmentsRef = useRef<SelectedAttachment[]>([]);

  useEffect(() => {
    const initializeCreate = async () => {
      try {
        await appService.initialize();
      } catch (error) {
        logger.error('initialization_failed', error);
        Alert.alert(
          'Initialization failed',
          error instanceof Error ? error.message : 'Unable to initialize create screen.',
        );
      } finally {
        setLoading(false);
      }
    };
    void initializeCreate();
  }, []);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    return () => {
      for (const attachment of attachmentsRef.current) {
        revokePreviewUrl(attachment.previewUrl);
      }
    };
  }, []);

  const handleContentChange = (text: string) => {
    if (text.length <= MAX_CHARS) {
      setContent(text);
      setCharCount(text.length);
    }
  };

  const uploadFiles = useCallback(
    async (files: WebFile[]) => {
      if (files.length === 0) {
        return;
      }

      const validation = validateSelectedFiles(files, attachments);
      if (!validation.valid) {
        Alert.alert('Attachment limit', validation.message);
        return;
      }

      try {
        setIsPicking(true);
        await appService.initialize();
        const author = appService.getLocalPeerId() ?? appService.getCryptoService().loadIdentity();
        if (!author) {
          throw new Error('Local identity is not available');
        }

        const uploaded: SelectedAttachment[] = [];
        const mediaService = appService.getMediaUploadService();
        const batchId = Date.now();
        const queueItems = files.map((file, index) => ({
          id: createUploadQueueItemId(file, index, batchId),
          name: file.name,
          size: file.size,
          type: inferMediaType(file.type, file.name),
          status: 'queued' as const,
          message: 'Waiting to be fragmented',
        }));
        setUploadQueue((current) => [
          ...queueItems,
          ...current.filter((item) => item.status !== 'ready'),
        ]);

        for (let index = 0; index < files.length; index += 1) {
          const file = files[index];
          const queueId = queueItems[index].id;
          setUploadQueue((current) =>
            current.map((item) =>
              item.id === queueId
                ? { ...item, status: 'processing', message: 'Reading and hashing file' }
                : item,
            ),
          );
          const bytes = new Uint8Array(await file.arrayBuffer());
          const type = inferMediaType(file.type, file.name);
          setUploadQueue((current) =>
            current.map((item) =>
              item.id === queueId
                ? {
                    ...item,
                    message: `Fragmenting into ${estimateChunkCount(bytes.length)} chunk(s)`,
                  }
                : item,
            ),
          );
          const result = await mediaService.uploadMedia(
            author,
            type,
            file.type || 'application/octet-stream',
            bytes,
          );
          if (!result.success || !result.mediaObject) {
            setUploadQueue((current) =>
              current.map((item) =>
                item.id === queueId
                  ? {
                      ...item,
                      status: 'failed',
                      message: result.error ?? `Unable to upload ${file.name}`,
                    }
                  : item,
              ),
            );
            throw new Error(result.error ?? `Unable to upload ${file.name}`);
          }

          const previewUrl = createPreviewUrl(bytes, file.type || 'application/octet-stream');
          uploaded.push({
            id: result.mediaObject.id,
            type: result.mediaObject.type,
            mime: result.mediaObject.mime,
            size: result.mediaObject.size,
            hash: result.mediaObject.hash,
            chunks: result.mediaObject.chunks,
            name: file.name,
            previewUrl,
          });
          setUploadQueue((current) =>
            current.map((item) =>
              item.id === queueId
                ? {
                    ...item,
                    status: 'ready',
                    message: `${result.mediaObject?.chunks.length ?? 0} chunk(s) stored locally`,
                  }
                : item,
            ),
          );
        }

        setAttachments((current) => [...current, ...uploaded]);
      } catch (error) {
        logger.error('upload_failed', error);
        Alert.alert(
          'Upload failed',
          error instanceof Error ? error.message : 'Unable to upload attachment.',
        );
      } finally {
        setIsPicking(false);
      }
    },
    [attachments],
  );

  const pickFiles = useCallback(
    (accept: string) => {
      const webDocument = (globalThis as unknown as { document?: WebDocument }).document;
      if (!webDocument) {
        Alert.alert(
          'File picker unavailable',
          'This environment does not expose a native file picker yet.',
        );
        return;
      }

      setIsPicking(true);
      const input = webDocument.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.multiple = true;
      input.onchange = () => {
        const files = Array.from(input.files ?? []);
        void uploadFiles(files);
      };
      input.click();
    },
    [uploadFiles],
  );

  const handlePost = async () => {
    if (!content.trim() && attachments.length === 0) {
      Alert.alert('Empty post', 'Write something or attach a file before posting.');
      return;
    }

    setIsPosting(true);
    try {
      await appService.initialize();
      const author = appService.getLocalPeerId() ?? appService.getCryptoService().loadIdentity();
      if (!author) {
        throw new Error('Local identity is not available');
      }

      const result = await appService.getSocialApplicationService().createPost({
        text: content.trim(),
        mediaAttachments: attachments,
      });

      setContent('');
      setCharCount(0);
      setAttachments((current) => {
        for (const attachment of current) {
          revokePreviewUrl(attachment.previewUrl);
        }
        return [];
      });
      setUploadQueue([]);
      Alert.alert(
        'Post created',
        result.replication.attemptedPeers > 0
          ? `Post stored and replicated to ${result.replication.successfulPeers} peer(s).`
          : 'Post stored locally. It will replicate when trusted peers are connected.',
      );
    } catch (error) {
      logger.error('post_create_failed', error);
      Alert.alert('Post failed', error instanceof Error ? error.message : 'Failed to create post');
    } finally {
      setIsPosting(false);
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      revokePreviewUrl(removed?.previewUrl);
      return current.filter((attachment) => attachment.id !== id);
    });
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading composer...</Text>
      </View>
    );
  }

  const hasActiveUpload = uploadQueue.some(
    (item) => item.status === 'queued' || item.status === 'processing',
  );
  const canPost =
    (!!content.trim() || attachments.length > 0) && !isPosting && !isPicking && !hasActiveUpload;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <View style={styles.header}>
        <Text style={styles.title}>Create Post</Text>
        <Text style={styles.subtitle}>
          Publish text and distributed media into your local P2P store.
        </Text>
      </View>

      <View style={styles.composerContainer}>
        <TextInput
          testID="create-post-composer"
          style={styles.composer}
          placeholder="What's on your mind?"
          placeholderTextColor="#8E8E93"
          multiline
          value={content}
          onChangeText={handleContentChange}
          maxLength={MAX_CHARS}
          autoFocus
        />

        {attachments.length > 0 && (
          <View style={styles.attachmentList}>
            {attachments.map((attachment) => (
              <View key={attachment.id} style={styles.attachmentRow}>
                <AttachmentPreview attachment={attachment} />
                <View style={styles.attachmentInfo}>
                  <Text style={styles.attachmentName}>{attachment.name}</Text>
                  <Text style={styles.attachmentMeta}>
                    {attachment.type} - {formatBytes(attachment.size)} - {attachment.chunks.length}{' '}
                    chunks
                  </Text>
                  <Text style={styles.attachmentHash}>
                    sha256 {attachment.hash.slice(0, 16)}...
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.removeButton}
                  onPress={() => removeAttachment(attachment.id)}
                >
                  <Text style={styles.removeButtonText}>Remove</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {uploadQueue.length > 0 && (
          <View testID="create-upload-queue" style={styles.uploadQueue}>
            <Text style={styles.queueTitle}>Attachment queue</Text>
            {uploadQueue.map((item) => (
              <View key={item.id} style={styles.queueRow}>
                <View style={styles.queueInfo}>
                  <Text style={styles.queueName}>{item.name}</Text>
                  <Text style={styles.queueMeta}>
                    {item.type} - {formatBytes(item.size)}
                  </Text>
                  <Text style={styles.queueMessage}>{item.message}</Text>
                </View>
                <View style={[styles.queueBadge, getQueueBadgeStyle(item.status)]}>
                  <Text style={styles.queueBadgeText}>{item.status}</Text>
                </View>
              </View>
            ))}
          </View>
        )}

        <View style={styles.composerFooter}>
          <Text style={[styles.charCount, charCount > MAX_CHARS * 0.9 && styles.charCountWarning]}>
            {charCount}/{MAX_CHARS}
          </Text>
          <TouchableOpacity
            testID="create-post-submit"
            style={[styles.postButton, !canPost && styles.postButtonDisabled]}
            onPress={handlePost}
            disabled={!canPost}
          >
            <Text style={styles.postButtonText}>{isPosting ? 'Posting...' : 'Post'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.attachments}>
        <TouchableOpacity
          testID="create-attachment-image"
          style={styles.attachmentButton}
          onPress={() => pickFiles('image/*')}
          disabled={isPicking}
        >
          <Text style={styles.attachmentButtonText}>Image</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.attachmentButton}
          onPress={() => pickFiles('video/*')}
          disabled={isPicking}
        >
          <Text style={styles.attachmentButtonText}>Video</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.attachmentButton}
          onPress={() => pickFiles('audio/*')}
          disabled={isPicking}
        >
          <Text style={styles.attachmentButtonText}>Audio</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.attachmentButton}
          onPress={() => pickFiles('*/*')}
          disabled={isPicking}
        >
          <Text style={styles.attachmentButtonText}>Any file</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.syncStatus}>
        <Text style={styles.syncText}>
          {isPicking || hasActiveUpload
            ? 'Processing attachment chunks...'
            : isPosting
              ? 'Publishing post...'
              : 'Ready'}
        </Text>
      </View>
    </ScrollView>
  );
}

function AttachmentPreview({ attachment }: { attachment: SelectedAttachment }) {
  if (attachment.type === 'image' && attachment.previewUrl) {
    return (
      <Image
        source={{ uri: attachment.previewUrl }}
        style={styles.previewImage}
        resizeMode="cover"
      />
    );
  }

  return (
    <View style={styles.filePreview}>
      <Text style={styles.filePreviewText}>{attachment.type.toUpperCase().slice(0, 3)}</Text>
    </View>
  );
}

function getQueueBadgeStyle(status: UploadQueueItem['status']) {
  switch (status) {
    case 'ready':
      return styles.queue_ready;
    case 'failed':
      return styles.queue_failed;
    case 'processing':
      return styles.queue_processing;
    case 'queued':
    default:
      return styles.queue_queued;
  }
}

function validateSelectedFiles(
  files: WebFile[],
  currentAttachments: SelectedAttachment[],
): { valid: true } | { valid: false; message: string } {
  if (currentAttachments.length + files.length > MAX_ATTACHMENTS) {
    return {
      valid: false,
      message: `You can attach up to ${MAX_ATTACHMENTS} files per post.`,
    };
  }

  const oversized = files.find((file) => file.size > MAX_FILE_SIZE_BYTES);
  if (oversized) {
    return {
      valid: false,
      message: `${oversized.name} is larger than ${formatBytes(MAX_FILE_SIZE_BYTES)}.`,
    };
  }

  const nextTotal =
    currentAttachments.reduce((sum, attachment) => sum + attachment.size, 0) +
    files.reduce((sum, file) => sum + file.size, 0);
  if (nextTotal > MAX_TOTAL_ATTACHMENT_BYTES) {
    return {
      valid: false,
      message: `This post would exceed ${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)} of attachments.`,
    };
  }

  return { valid: true };
}

function createUploadQueueItemId(file: WebFile, index: number, batchId: number): string {
  return `upload_${batchId}_${sanitizeQueueIdPart(file.name)}_${file.size}_${index}`;
}

function sanitizeQueueIdPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 48);
}

function estimateChunkCount(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / (64 * 1024)));
}

function createPreviewUrl(bytes: Uint8Array, mime: string): string | undefined {
  const globals = getWebPreviewGlobals();
  if (!globals) {
    return undefined;
  }
  return globals.createObjectURL(
    new globals.Blob([toArrayBuffer(bytes)], {
      type: mime,
    }),
  );
}

function revokePreviewUrl(url: string | undefined): void {
  if (!url) {
    return;
  }
  getWebPreviewGlobals()?.revokeObjectURL(url);
}

function getWebPreviewGlobals(): {
  Blob: new (parts: ArrayBuffer[], options: { type: string }) => unknown;
  createObjectURL: (value: unknown) => string;
  revokeObjectURL: (url: string) => void;
} | null {
  const candidate = globalThis as unknown as {
    Blob?: new (parts: ArrayBuffer[], options: { type: string }) => unknown;
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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function inferMediaType(mime: string, name: string): MediaType {
  if (mime.startsWith('image/')) {
    return 'image';
  }
  if (mime.startsWith('video/')) {
    return 'video';
  }
  if (mime.startsWith('audio/')) {
    return 'audio';
  }
  const extension = name.split('.').pop()?.toLowerCase();
  if (extension && ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)) {
    return 'image';
  }
  if (extension && ['mp4', 'mov', 'webm', 'mkv'].includes(extension)) {
    return 'video';
  }
  if (extension && ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].includes(extension)) {
    return 'audio';
  }
  return 'document';
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
  subtitle: {
    color: '#8E8E93',
    fontSize: 14,
    marginTop: 6,
  },
  loadingText: {
    fontSize: 16,
    color: '#8E8E93',
    marginTop: 12,
  },
  composerContainer: {
    backgroundColor: '#0A0A0F',
    borderRadius: 8,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1C1C1E',
    marginBottom: 16,
  },
  composer: {
    fontSize: 16,
    color: '#FFFFFF',
    minHeight: 120,
    textAlignVertical: 'top',
  },
  attachmentList: {
    gap: 10,
    marginTop: 12,
  },
  attachmentRow: {
    alignItems: 'center',
    backgroundColor: '#050509',
    borderColor: '#1C1C1E',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    padding: 12,
  },
  attachmentInfo: {
    flex: 1,
  },
  attachmentName: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  attachmentMeta: {
    color: '#8E8E93',
    fontSize: 12,
    marginTop: 4,
  },
  attachmentHash: {
    color: '#636366',
    fontSize: 11,
    marginTop: 4,
  },
  filePreview: {
    alignItems: 'center',
    backgroundColor: '#1C1C1E',
    borderRadius: 8,
    height: 54,
    justifyContent: 'center',
    width: 54,
  },
  filePreviewText: {
    color: '#8E8E93',
    fontSize: 12,
    fontWeight: '800',
  },
  previewImage: {
    backgroundColor: '#1C1C1E',
    borderRadius: 8,
    height: 54,
    width: 54,
  },
  uploadQueue: {
    borderTopColor: '#1C1C1E',
    borderTopWidth: 1,
    gap: 8,
    marginTop: 12,
    paddingTop: 12,
  },
  queueTitle: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
  queueRow: {
    alignItems: 'center',
    backgroundColor: '#050509',
    borderColor: '#1C1C1E',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    padding: 12,
  },
  queueInfo: {
    flex: 1,
    gap: 3,
  },
  queueName: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  queueMeta: {
    color: '#8E8E93',
    fontSize: 12,
  },
  queueMessage: {
    color: '#636366',
    fontSize: 11,
  },
  queueBadge: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  queueBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  queue_failed: {
    backgroundColor: 'rgba(255, 59, 48, 0.26)',
  },
  queue_processing: {
    backgroundColor: 'rgba(10, 132, 255, 0.24)',
  },
  queue_queued: {
    backgroundColor: 'rgba(142, 142, 147, 0.22)',
  },
  queue_ready: {
    backgroundColor: 'rgba(52, 199, 89, 0.24)',
  },
  removeButton: {
    backgroundColor: '#2C2C2E',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  removeButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  composerFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#1C1C1E',
  },
  charCount: {
    fontSize: 12,
    color: '#8E8E93',
  },
  charCountWarning: {
    color: '#FF3B30',
  },
  postButton: {
    backgroundColor: '#007AFF',
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  postButtonDisabled: {
    backgroundColor: '#1C1C1E',
  },
  postButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  attachments: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  attachmentButton: {
    backgroundColor: '#0A0A0F',
    borderRadius: 8,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: '#1C1C1E',
    flex: 1,
    alignItems: 'center',
  },
  attachmentButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  syncStatus: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  syncText: {
    fontSize: 14,
    color: '#8E8E93',
  },
});
