import { createNetworkMessage, estimateNetworkMessageBytes } from '@/network/NetworkMessage';
import type { PeerConnection, PeerConnectionFlowControl } from '@/network/PeerTransport';
import type { PeerId } from '@/network/NetworkTypes';

import {
  calculateMaxRawPayloadBytes,
  MediaTransferError,
  MediaTransferScheduler,
  type MediaTransferSchedulerPolicy,
} from '../MediaTransferScheduler';

describe('MediaTransferScheduler', () => {
  it('calculates the largest raw payload from the full UTF-8 and base64 frame', () => {
    const maxFrameBytes = 1200;
    const totalRawBytes = 4096;
    const buildFrame = (rawBytes: number, totalParts: number) =>
      createNetworkMessage({
        messageType: 'media.chunk.part',
        senderId: 'peer-á',
        timestamp: 1000,
        ttlMs: 5000,
        correlationId: 'correlação',
        payload: {
          version: 1,
          type: 'media.chunk.part',
          partIndex: totalParts - 1,
          totalParts,
          dataBase64: 'A'.repeat(Math.ceil(rawBytes / 3) * 4),
        },
      });

    const rawBytes = calculateMaxRawPayloadBytes({
      totalRawBytes,
      maxFrameBytes,
      buildFrame,
    });

    expect(rawBytes).toBeGreaterThan(0);
    expect(
      estimateNetworkMessageBytes(buildFrame(rawBytes, Math.ceil(totalRawBytes / rawBytes))),
    ).toBeLessThanOrEqual(maxFrameBytes);
    expect(
      estimateNetworkMessageBytes(
        buildFrame(rawBytes + 1, Math.ceil(totalRawBytes / (rawBytes + 1))),
      ),
    ).toBeGreaterThan(maxFrameBytes);
  });

  it('waits for bufferedamountlow before sending and removes the listener', async () => {
    const flow = createFlowControl(200, 100);
    const connection = createConnection('peer-a', flow.control);
    const scheduler = new MediaTransferScheduler(createPolicy());
    const send = jest.fn(async () => undefined);

    const transfer = scheduler.enqueue({ connection, bytes: 50, send });
    await flushPromises();
    expect(send).not.toHaveBeenCalled();
    expect(scheduler.getSnapshot()).toMatchObject({ blockedPeers: 1, writableWaits: 1 });

    flow.release(40);
    await transfer;

    expect(send).toHaveBeenCalledTimes(1);
    expect(flow.getUnsubscribeCount()).toBe(1);
    expect(scheduler.getSnapshot()).toMatchObject({ blockedPeers: 0, sentFrames: 1 });
  });

  it('uses independent queues so a blocked peer does not stop another peer', async () => {
    const blockedFlow = createFlowControl(200, 100);
    const blockedConnection = createConnection('peer-a', blockedFlow.control);
    const writableConnection = createConnection('peer-b');
    const scheduler = new MediaTransferScheduler(createPolicy());
    const blockedSend = jest.fn(async () => undefined);
    const writableSend = jest.fn(async () => undefined);

    const blockedTransfer = scheduler.enqueue({
      connection: blockedConnection,
      bytes: 20,
      send: blockedSend,
    });
    await scheduler.enqueue({
      connection: writableConnection,
      bytes: 20,
      send: writableSend,
    });

    expect(writableSend).toHaveBeenCalledTimes(1);
    expect(blockedSend).not.toHaveBeenCalled();

    blockedFlow.release(0);
    await blockedTransfer;
  });

  it('rejects bounded queues instead of growing pending frames indefinitely', async () => {
    const gate = createDeferred<void>();
    const scheduler = new MediaTransferScheduler(
      createPolicy({ maxQueuedFramesPerPeer: 2, maxQueuedBytesPerPeer: 200 }),
    );
    const connection = createConnection('peer-a');
    const first = scheduler.enqueue({
      connection,
      bytes: 80,
      mediaObjectId: 'media-a',
      chunkId: 'chunk-a',
      send: async () => await gate.promise,
    });
    await flushPromises();
    const second = scheduler.enqueue({
      connection,
      bytes: 80,
      mediaObjectId: 'media-a',
      chunkId: 'chunk-b',
      send: async () => undefined,
    });

    await expect(
      scheduler.enqueue({
        connection,
        bytes: 80,
        mediaObjectId: 'media-a',
        chunkId: 'chunk-c',
        send: async () => undefined,
      }),
    ).rejects.toMatchObject({ kind: 'backpressure' });

    gate.resolve();
    await first;
    await second;
    expect(scheduler.getSnapshot()).toMatchObject({ rejectedFrames: 1, sentFrames: 2 });
  });

  it('cancels blocked and queued work and releases listeners on stop', async () => {
    const flow = createFlowControl(200, 100);
    const scheduler = new MediaTransferScheduler(createPolicy({ maxQueuedFramesPerPeer: 4 }));
    const connection = createConnection('peer-a', flow.control);
    const active = scheduler.enqueue({
      connection,
      bytes: 40,
      mediaObjectId: 'media-a',
      send: async () => undefined,
    });
    const queued = scheduler.enqueue({
      connection,
      bytes: 40,
      mediaObjectId: 'media-b',
      send: async () => undefined,
    });
    await flushPromises();

    scheduler.stop();
    const results = await Promise.allSettled([active, queued]);

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(flow.getUnsubscribeCount()).toBe(1);
    expect(scheduler.getSnapshot()).toMatchObject({
      running: false,
      queuedFrames: 0,
      cancelledFrames: 2,
    });
  });

  it('returns a typed frame-too-large error before invoking the sender', async () => {
    const scheduler = new MediaTransferScheduler(createPolicy({ maxFrameBytes: 100 }));
    const send = jest.fn(async () => undefined);

    await expect(
      scheduler.enqueue({ connection: createConnection('peer-a'), bytes: 101, send }),
    ).rejects.toEqual(expect.any(MediaTransferError));
    await expect(
      scheduler.enqueue({ connection: createConnection('peer-a'), bytes: 101, send }),
    ).rejects.toMatchObject({ kind: 'frame-too-large', retryable: false });
    expect(send).not.toHaveBeenCalled();
  });
});

function createPolicy(
  patch: Partial<MediaTransferSchedulerPolicy> = {},
): MediaTransferSchedulerPolicy {
  return {
    maxFrameBytes: 1024,
    maxQueuedFramesPerPeer: 8,
    maxQueuedBytesPerPeer: 1024,
    maxQueuedObjectsPerPeer: 8,
    maxQueuedChunksPerPeer: 8,
    writableTimeoutMs: 1000,
    lowWaterMarkRatio: 0.5,
    ...patch,
  };
}

function createConnection(peerId: string, flowControl?: PeerConnectionFlowControl): PeerConnection {
  return {
    peerId: peerId as PeerId,
    localPeerId: 'local-peer' as PeerId,
    connectedAt: 1,
    lastSeenAt: 1,
    flowControl,
    send: async () => undefined,
  };
}

function createFlowControl(
  initialAmount: number,
  highWaterMark: number,
): {
  control: PeerConnectionFlowControl;
  release(amount: number): void;
  getUnsubscribeCount(): number;
} {
  let bufferedAmount = initialAmount;
  let handler: (() => void) | undefined;
  let unsubscribeCount = 0;
  return {
    control: {
      getBufferedAmount: () => bufferedAmount,
      getHighWaterMark: () => highWaterMark,
      setLowWaterMark: () => undefined,
      isOpen: () => true,
      subscribe: (nextHandler) => {
        handler = nextHandler;
        return () => {
          handler = undefined;
          unsubscribeCount += 1;
        };
      },
    },
    release: (amount) => {
      bufferedAmount = amount;
      handler?.();
    },
    getUnsubscribeCount: () => unsubscribeCount,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
