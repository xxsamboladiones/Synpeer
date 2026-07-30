import type { TestInfo } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { reopenMeshPeer, type MeshPeer } from './mesh-fixture';

type MeshFaultEvent = {
  sequence: number;
  faultId: string;
  type: 'peer.partition.started' | 'peer.partition.completed' | 'peer.restore.completed';
  peer: string;
  elapsedMs: number;
};

type MeshMeasurement = {
  name: string;
  outcome: 'passed' | 'failed';
  durationMs: number;
};

type MeshRunManifest = {
  version: 1;
  scenario: string;
  seed: number;
  topology: readonly string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  peers: Array<{ label: string; peerId: string }>;
  faults: MeshFaultEvent[];
  measurements: MeshMeasurement[];
};

export class MeshFaultController {
  private readonly startedAt = Date.now();
  private readonly faults: MeshFaultEvent[] = [];
  private readonly measurements: MeshMeasurement[] = [];
  private sequence = 0;

  constructor(
    private readonly scenario: string,
    private readonly seed: number,
    private readonly topology: readonly string[],
  ) {}

  async partitionPeer(peer: MeshPeer): Promise<void> {
    this.recordFault('peer.partition.started', peer);
    if (!peer.page.isClosed()) {
      await peer.page.close();
    }
    this.recordFault('peer.partition.completed', peer);
  }

  async restorePeer(peer: MeshPeer): Promise<void> {
    await this.measure(`restore-${peer.label}`, async () => {
      await reopenMeshPeer(peer);
    });
    this.recordFault('peer.restore.completed', peer);
  }

  async measure<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await operation();
      this.measurements.push({
        name,
        outcome: 'passed',
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      this.measurements.push({
        name,
        outcome: 'failed',
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  async attachManifest(testInfo: TestInfo, peers: MeshPeer[]): Promise<void> {
    const finishedAt = Date.now();
    const manifest: MeshRunManifest = {
      version: 1,
      scenario: this.scenario,
      seed: this.seed,
      topology: this.topology,
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - this.startedAt,
      peers: peers.map((peer) => ({ label: peer.label, peerId: peer.peerId })),
      faults: [...this.faults],
      measurements: [...this.measurements],
    };
    const manifestBody = JSON.stringify(manifest, null, 2);
    const manifestDirectory = path.resolve('test-results', 'mesh-manifests');
    const manifestPath = path.join(
      manifestDirectory,
      `${sanitizeFileName(this.scenario)}-${this.seed}-${this.startedAt}.json`,
    );
    await mkdir(manifestDirectory, { recursive: true });
    await writeFile(manifestPath, manifestBody, 'utf8');
    await testInfo.attach('mesh-run-manifest', {
      body: Buffer.from(manifestBody, 'utf8'),
      contentType: 'application/json',
    });
  }

  private recordFault(type: MeshFaultEvent['type'], peer: MeshPeer): void {
    const sequence = this.sequence;
    this.sequence += 1;
    this.faults.push({
      sequence,
      faultId: `${this.seed}-${sequence}`,
      type,
      peer: peer.label,
      elapsedMs: Date.now() - this.startedAt,
    });
  }
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '');
}
