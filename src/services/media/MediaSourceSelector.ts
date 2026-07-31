import type { PeerId } from '@/network/NetworkTypes';

import type { MediaDownloadRepository } from './MediaDownloadRepository';

export interface MediaSourceSelection {
  mediaObjectId: string;
  chunkId: string;
  candidatePeers: readonly PeerId[];
  now?: number;
}

interface RankedMediaSource {
  peerId: PeerId;
  advertised: boolean;
  successes: number;
  failures: number;
  latencyMs: number;
  updatedAt: number;
}

export class MediaSourceSelector {
  constructor(
    private readonly repository: MediaDownloadRepository,
    private readonly now: () => number = Date.now,
  ) {}

  select(input: MediaSourceSelection): PeerId[] {
    const now = input.now ?? this.now();
    const advertisedPeers = new Set(
      this.repository.findPeersForChunk(input.mediaObjectId, input.chunkId, now),
    );
    const candidates = Array.from(new Set([...advertisedPeers, ...input.candidatePeers])).filter(
      (peerId) =>
        !this.repository.isReplicaQuarantined(peerId, input.mediaObjectId, input.chunkId, now),
    );

    return candidates
      .map((peerId): RankedMediaSource => {
        const observation = this.repository.getReplicaObservation(
          peerId,
          input.mediaObjectId,
          input.chunkId,
        );
        return {
          peerId,
          advertised: advertisedPeers.has(peerId),
          successes: observation?.successCount ?? 0,
          failures: observation?.failureCount ?? 0,
          latencyMs: observation?.latencyMs ?? Number.MAX_SAFE_INTEGER,
          updatedAt: observation?.updatedAt ?? 0,
        };
      })
      .sort(compareMediaSources)
      .map((candidate) => candidate.peerId);
  }
}

function compareMediaSources(left: RankedMediaSource, right: RankedMediaSource): number {
  if (left.advertised !== right.advertised) {
    return left.advertised ? -1 : 1;
  }

  const leftReliability = left.successes - left.failures;
  const rightReliability = right.successes - right.failures;
  return (
    rightReliability - leftReliability ||
    left.failures - right.failures ||
    left.latencyMs - right.latencyMs ||
    right.updatedAt - left.updatedAt ||
    String(left.peerId).localeCompare(String(right.peerId))
  );
}
