import { AppError } from '@/errors/AppError';
import { MAX_NETWORK_MESSAGE_BYTES, estimateNetworkMessageBytes } from '@/network/NetworkMessage';
import type { PeerConnection, PeerConnectionFlowControl } from '@/network/PeerTransport';
import type { PeerId } from '@/network/NetworkTypes';

export type MediaTransferFailureKind =
  | 'timeout'
  | 'unavailable'
  | 'corrupt'
  | 'cancelled'
  | 'storage-full'
  | 'backpressure'
  | 'frame-too-large';

export class MediaTransferError extends AppError {
  constructor(
    readonly kind: MediaTransferFailureKind,
    options: {
      message: string;
      safeMessage: string;
      retryable: boolean;
      peerId?: PeerId;
      mediaObjectId?: string;
      chunkId?: string;
      cause?: unknown;
    },
  ) {
    super({
      code: 'MEDIA_ERROR',
      message: options.message,
      safeMessage: options.safeMessage,
      severity: kind === 'corrupt' ? 'error' : 'warning',
      retryable: options.retryable,
      context: {
        scope: 'media.transfer.scheduler',
        peerId: options.peerId,
        mediaObjectId: options.mediaObjectId,
        chunkId: options.chunkId,
        failureKind: kind,
      },
      cause: options.cause,
    });
    this.name = 'MediaTransferError';
  }
}

export interface MediaTransferSchedulerPolicy {
  maxFrameBytes: number;
  maxQueuedFramesPerPeer: number;
  maxQueuedBytesPerPeer: number;
  maxQueuedObjectsPerPeer: number;
  maxQueuedChunksPerPeer: number;
  writableTimeoutMs: number;
  lowWaterMarkRatio: number;
}

export const defaultMediaTransferSchedulerPolicy: MediaTransferSchedulerPolicy = {
  maxFrameBytes: MAX_NETWORK_MESSAGE_BYTES,
  maxQueuedFramesPerPeer: 64,
  maxQueuedBytesPerPeer: 8 * 1024 * 1024,
  maxQueuedObjectsPerPeer: 4,
  maxQueuedChunksPerPeer: 8,
  writableTimeoutMs: 10000,
  lowWaterMarkRatio: 0.5,
};

export interface MediaTransferTask {
  connection: PeerConnection;
  bytes: number;
  mediaObjectId?: string;
  chunkId?: string;
  priority?: number;
  send(): Promise<void>;
}

export interface MediaTransferSchedulerSnapshot {
  running: boolean;
  activePeers: number;
  blockedPeers: number;
  queuedFrames: number;
  queuedBytes: number;
  inFlightBytes: number;
  sentFrames: number;
  sentBytes: number;
  rejectedFrames: number;
  cancelledFrames: number;
  writableWaits: number;
}

interface QueuedMediaTransferTask extends MediaTransferTask {
  sequence: number;
  resolve(): void;
  reject(error: MediaTransferError): void;
}

interface PeerTransferQueue {
  tasks: QueuedMediaTransferTask[];
  queuedBytes: number;
  processing: boolean;
  blocked: boolean;
  cancelled: boolean;
  activeTask?: QueuedMediaTransferTask;
  cancelWait?: (error: MediaTransferError) => void;
}

export class MediaTransferScheduler {
  private readonly queues = new Map<PeerId, PeerTransferQueue>();
  private sequence = 0;
  private running = true;
  private sentFrames = 0;
  private sentBytes = 0;
  private rejectedFrames = 0;
  private cancelledFrames = 0;
  private writableWaits = 0;

  constructor(
    private readonly policy: MediaTransferSchedulerPolicy = defaultMediaTransferSchedulerPolicy,
  ) {
    validatePolicy(policy);
  }

  start(): void {
    this.running = true;
  }

  async enqueue(task: MediaTransferTask): Promise<void> {
    if (!this.running) {
      throw createTransferError('cancelled', task, 'Media transfer scheduler is stopped');
    }
    if (!Number.isSafeInteger(task.bytes) || task.bytes <= 0) {
      throw createTransferError('frame-too-large', task, 'Media transfer frame size is invalid');
    }
    if (task.bytes > this.policy.maxFrameBytes) {
      this.rejectedFrames += 1;
      throw createTransferError(
        'frame-too-large',
        task,
        `Media transfer frame exceeds ${this.policy.maxFrameBytes} bytes`,
      );
    }

    const peerId = task.connection.peerId;
    const queue = this.queues.get(peerId) ?? createPeerQueue();
    this.assertQueueCapacity(queue, task);
    this.queues.set(peerId, queue);

    await new Promise<void>((resolve, reject) => {
      queue.tasks.push({
        ...task,
        sequence: this.sequence++,
        resolve,
        reject,
      });
      queue.queuedBytes += task.bytes;
      void this.processPeerQueue(peerId, queue);
    });
  }

  cancelPeer(peerId: PeerId): void {
    const queue = this.queues.get(peerId);
    if (!queue) {
      return;
    }
    const error = new MediaTransferError('cancelled', {
      message: 'Media transfers cancelled because the peer disconnected',
      safeMessage: 'A transferencia foi interrompida porque o peer desconectou.',
      retryable: true,
      peerId,
    });
    queue.cancelled = true;
    queue.cancelWait?.(error);
    this.rejectQueuedTasks(queue, error);
    if (!queue.processing) {
      this.queues.delete(peerId);
    }
  }

  cancelMedia(mediaObjectId: string): void {
    for (const [peerId, queue] of this.queues) {
      if (queue.activeTask?.mediaObjectId === mediaObjectId) {
        queue.cancelWait?.(
          createTransferError(
            'cancelled',
            queue.activeTask,
            'Media transfer cancelled by the local user',
          ),
        );
      }
      const retained: QueuedMediaTransferTask[] = [];
      for (const task of queue.tasks) {
        if (task.mediaObjectId !== mediaObjectId) {
          retained.push(task);
          continue;
        }
        queue.queuedBytes -= task.bytes;
        this.cancelledFrames += 1;
        task.reject(
          createTransferError('cancelled', task, 'Media transfer cancelled by the local user'),
        );
      }
      queue.tasks = retained;
      if (!queue.processing && queue.tasks.length === 0) {
        this.queues.delete(peerId);
      }
    }
  }

  stop(): void {
    if (!this.running && this.queues.size === 0) {
      return;
    }
    this.running = false;
    for (const peerId of [...this.queues.keys()]) {
      this.cancelPeer(peerId);
    }
  }

  getSnapshot(): MediaTransferSchedulerSnapshot {
    let queuedFrames = 0;
    let queuedBytes = 0;
    let inFlightBytes = 0;
    let activePeers = 0;
    let blockedPeers = 0;
    for (const queue of this.queues.values()) {
      queuedFrames += queue.tasks.length;
      queuedBytes += queue.queuedBytes;
      inFlightBytes += queue.activeTask?.bytes ?? 0;
      activePeers += queue.processing ? 1 : 0;
      blockedPeers += queue.blocked ? 1 : 0;
    }
    return {
      running: this.running,
      activePeers,
      blockedPeers,
      queuedFrames,
      queuedBytes,
      inFlightBytes,
      sentFrames: this.sentFrames,
      sentBytes: this.sentBytes,
      rejectedFrames: this.rejectedFrames,
      cancelledFrames: this.cancelledFrames,
      writableWaits: this.writableWaits,
    };
  }

  private assertQueueCapacity(queue: PeerTransferQueue, task: MediaTransferTask): void {
    const peerTasks = queue.activeTask ? [queue.activeTask, ...queue.tasks] : queue.tasks;
    const objectIds = new Set(
      peerTasks.map((queued) => queued.mediaObjectId).filter(isDefinedString),
    );
    const chunkIds = new Set(peerTasks.map((queued) => queued.chunkId).filter(isDefinedString));
    if (task.mediaObjectId) {
      objectIds.add(task.mediaObjectId);
    }
    if (task.chunkId) {
      chunkIds.add(task.chunkId);
    }
    const capacityExceeded =
      peerTasks.length >= this.policy.maxQueuedFramesPerPeer ||
      queue.queuedBytes + (queue.activeTask?.bytes ?? 0) + task.bytes >
        this.policy.maxQueuedBytesPerPeer ||
      objectIds.size > this.policy.maxQueuedObjectsPerPeer ||
      chunkIds.size > this.policy.maxQueuedChunksPerPeer;
    if (!capacityExceeded) {
      return;
    }
    this.rejectedFrames += 1;
    throw createTransferError('backpressure', task, 'Media transfer queue capacity exceeded');
  }

  private async processPeerQueue(peerId: PeerId, queue: PeerTransferQueue): Promise<void> {
    if (queue.processing) {
      return;
    }
    queue.processing = true;
    try {
      while (this.running && queue.tasks.length > 0) {
        const task = takeNextTask(queue);
        queue.activeTask = task;
        try {
          await this.waitUntilWritable(queue, task);
          await task.send();
          if (!this.running || queue.cancelled) {
            throw createTransferError('cancelled', task, 'Media transfer was cancelled');
          }
          this.sentFrames += 1;
          this.sentBytes += task.bytes;
          task.resolve();
        } catch (error) {
          const transferError = toMediaTransferError(error, task);
          if (transferError.kind === 'cancelled') {
            this.cancelledFrames += 1;
          } else {
            this.rejectedFrames += 1;
          }
          task.reject(transferError);
          if (transferError.kind === 'unavailable') {
            this.rejectQueuedTasks(queue, transferError);
            break;
          }
        } finally {
          queue.activeTask = undefined;
        }
      }
    } finally {
      queue.processing = false;
      queue.blocked = false;
      queue.activeTask = undefined;
      queue.cancelWait = undefined;
      if (queue.tasks.length === 0) {
        this.queues.delete(peerId);
      } else if (this.running) {
        void this.processPeerQueue(peerId, queue);
      }
    }
  }

  private async waitUntilWritable(
    queue: PeerTransferQueue,
    task: QueuedMediaTransferTask,
  ): Promise<void> {
    const flowControl = task.connection.flowControl;
    if (!flowControl) {
      return;
    }
    if (!flowControl.isOpen()) {
      throw createTransferError('unavailable', task, 'Peer data channel is not open');
    }
    const highWaterMark = Math.min(
      flowControl.getHighWaterMark(),
      this.policy.maxQueuedBytesPerPeer,
    );
    if (flowControl.getBufferedAmount() <= highWaterMark) {
      return;
    }

    this.writableWaits += 1;
    queue.blocked = true;
    const lowWaterMark = Math.max(0, Math.floor(highWaterMark * this.policy.lowWaterMarkRatio));
    flowControl.setLowWaterMark(lowWaterMark);
    await waitForWritableState(
      flowControl,
      lowWaterMark,
      this.policy.writableTimeoutMs,
      task,
      (cancel) => {
        queue.cancelWait = cancel;
      },
    );
    queue.cancelWait = undefined;
    queue.blocked = false;
  }

  private rejectQueuedTasks(queue: PeerTransferQueue, error: MediaTransferError): void {
    const queued = queue.tasks.splice(0);
    queue.queuedBytes = 0;
    this.cancelledFrames += queued.length;
    for (const task of queued) {
      task.reject(error);
    }
  }
}

export function calculateMaxRawPayloadBytes(input: {
  totalRawBytes: number;
  maxFrameBytes?: number;
  buildFrame(rawBytes: number, totalParts: number): unknown;
}): number {
  const totalRawBytes = Math.max(0, Math.floor(input.totalRawBytes));
  const maxFrameBytes = input.maxFrameBytes ?? MAX_NETWORK_MESSAGE_BYTES;
  if (totalRawBytes === 0 || maxFrameBytes <= 0) {
    return 0;
  }

  let low = 1;
  let high = totalRawBytes;
  let best = 0;
  while (low <= high) {
    const candidate = low + Math.floor((high - low) / 2);
    const totalParts = Math.ceil(totalRawBytes / candidate);
    const frameBytes = estimateNetworkMessageBytes(input.buildFrame(candidate, totalParts));
    if (frameBytes <= maxFrameBytes) {
      best = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }
  return best;
}

export function toMediaTransferError(
  error: unknown,
  task?: Pick<MediaTransferTask, 'connection' | 'mediaObjectId' | 'chunkId'>,
): MediaTransferError {
  if (error instanceof MediaTransferError) {
    return error;
  }
  const message = error instanceof Error ? error.message : 'Unknown media transfer failure';
  const normalized = message.toLowerCase();
  const kind: MediaTransferFailureKind = isStorageCapacityError(error)
    ? 'storage-full'
    : normalized.includes('backpressure') || normalized.includes('congestion')
      ? 'backpressure'
      : normalized.includes('timeout')
        ? 'timeout'
        : normalized.includes('cancel')
          ? 'cancelled'
          : 'unavailable';
  return new MediaTransferError(kind, {
    message,
    safeMessage: getSafeTransferMessage(kind),
    retryable: true,
    peerId: task?.connection.peerId,
    mediaObjectId: task?.mediaObjectId,
    chunkId: task?.chunkId,
    cause: error,
  });
}

function waitForWritableState(
  flowControl: PeerConnectionFlowControl,
  lowWaterMark: number,
  timeoutMs: number,
  task: QueuedMediaTransferTask,
  registerCancel: (cancel: (error: MediaTransferError) => void) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (error?: MediaTransferError) => {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribe();
      if (timer) {
        globalThis.clearTimeout(timer);
      }
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const inspect = () => {
      if (!flowControl.isOpen()) {
        finish(createTransferError('unavailable', task, 'Peer data channel closed while blocked'));
      } else if (flowControl.getBufferedAmount() <= lowWaterMark) {
        finish();
      }
    };
    unsubscribe = flowControl.subscribe(inspect);
    registerCancel(finish);
    timer = globalThis.setTimeout(() => {
      finish(createTransferError('timeout', task, 'Timed out waiting for WebRTC backpressure'));
    }, timeoutMs);
    inspect();
  });
}

function createPeerQueue(): PeerTransferQueue {
  return {
    tasks: [],
    queuedBytes: 0,
    processing: false,
    blocked: false,
    cancelled: false,
  };
}

function takeNextTask(queue: PeerTransferQueue): QueuedMediaTransferTask {
  queue.tasks.sort(
    (left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.sequence - right.sequence,
  );
  const task = queue.tasks.shift();
  if (!task) {
    throw new Error('Media transfer queue is empty');
  }
  queue.queuedBytes -= task.bytes;
  return task;
}

function createTransferError(
  kind: MediaTransferFailureKind,
  task: Pick<MediaTransferTask, 'connection' | 'mediaObjectId' | 'chunkId'>,
  message: string,
): MediaTransferError {
  return new MediaTransferError(kind, {
    message,
    safeMessage: getSafeTransferMessage(kind),
    retryable: kind !== 'corrupt' && kind !== 'frame-too-large',
    peerId: task.connection.peerId,
    mediaObjectId: task.mediaObjectId,
    chunkId: task.chunkId,
  });
}

function getSafeTransferMessage(kind: MediaTransferFailureKind): string {
  switch (kind) {
    case 'timeout':
      return 'A transferencia demorou demais e pode ser tentada novamente.';
    case 'unavailable':
      return 'O peer nao esta disponivel para esta transferencia.';
    case 'corrupt':
      return 'O peer enviou dados que falharam na verificacao de integridade.';
    case 'cancelled':
      return 'A transferencia foi cancelada.';
    case 'storage-full':
      return 'Nao ha espaco local suficiente para concluir a transferencia.';
    case 'backpressure':
      return 'O canal P2P esta congestionado. A transferencia sera retomada depois.';
    case 'frame-too-large':
      return 'Uma parte da transferencia excede o limite do protocolo.';
  }
}

function isStorageCapacityError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === 'QuotaExceededError' ||
    error.message.toLowerCase().includes('quota') ||
    error.message.toLowerCase().includes('storage full')
  );
}

function isDefinedString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validatePolicy(policy: MediaTransferSchedulerPolicy): void {
  const positiveIntegers = [
    policy.maxFrameBytes,
    policy.maxQueuedFramesPerPeer,
    policy.maxQueuedBytesPerPeer,
    policy.maxQueuedObjectsPerPeer,
    policy.maxQueuedChunksPerPeer,
    policy.writableTimeoutMs,
  ];
  if (positiveIntegers.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error('Media transfer scheduler policy contains an invalid limit');
  }
  if (policy.lowWaterMarkRatio <= 0 || policy.lowWaterMarkRatio >= 1) {
    throw new Error('Media transfer scheduler low water mark ratio must be between zero and one');
  }
}
