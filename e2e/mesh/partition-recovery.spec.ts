import { expect, test } from '@playwright/test';

import { MeshFaultController } from './mesh-fault-controller';
import {
  closeMeshPeers,
  createConnectedLinearMesh,
  deleteOwnedPost,
  expectPeerConnected,
  expectSessionCount,
  getPostIdByText,
  LINEAR_MESH_TOPOLOGY,
  openAppTab,
  publishTextPost,
  readStoredPostState,
  type MeshPeer,
} from './mesh-fixture';

test.describe('four-peer partition recovery', () => {
  test('reopens B with persisted storage and converges both sides', async ({
    browser,
  }, testInfo) => {
    const peers: MeshPeer[] = [];
    const faults = new MeshFaultController(
      'partition-b-and-converge-social-state',
      15001,
      LINEAR_MESH_TOPOLOGY,
    );

    try {
      peers.push(
        ...(await faults.measure('mesh-bootstrap', () => createConnectedLinearMesh(browser))),
      );
      const [peerA, peerB, peerC, peerD] = peers;
      const peerBIdentity = peerB.peerId;

      await Promise.all([
        expectSessionCount(peerA.page, 1),
        expectSessionCount(peerB.page, 2),
        expectSessionCount(peerC.page, 2),
        expectSessionCount(peerD.page, 1),
      ]);

      await faults.partitionPeer(peerB);
      await Promise.all([
        publishTextPost(peerA.page, 'partition-post-from-a'),
        publishTextPost(peerD.page, 'partition-post-from-d'),
      ]);

      await faults.restorePeer(peerB);
      expect(peerB.peerId).toBe(peerBIdentity);
      await faults.measure('peer-b-reconnect', async () => {
        await Promise.all([
          expectPeerConnected(peerA, peerB.peerId),
          expectPeerConnected(peerB, peerA.peerId),
          expectPeerConnected(peerB, peerC.peerId),
          expectPeerConnected(peerC, peerB.peerId),
        ]);
      });

      await faults.measure('social-convergence', async () => {
        await Promise.all(peers.map((peer) => openAppTab(peer.page, 'Feed', '/feed')));
        await Promise.all(
          peers.flatMap((peer) => [
            expect(peer.page.getByText('partition-post-from-a', { exact: true })).toBeVisible({
              timeout: 45_000,
            }),
            expect(peer.page.getByText('partition-post-from-d', { exact: true })).toBeVisible({
              timeout: 45_000,
            }),
          ]),
        );
      });

      const deletedPostId = await getPostIdByText(peerA.page, 'partition-post-from-a');
      await faults.partitionPeer(peerB);
      await deleteOwnedPost(peerA.page, deletedPostId);
      await faults.restorePeer(peerB);
      await faults.measure('tombstone-reconnect', async () => {
        await Promise.all([
          expectPeerConnected(peerA, peerB.peerId),
          expectPeerConnected(peerB, peerA.peerId),
          expectPeerConnected(peerB, peerC.peerId),
          expectPeerConnected(peerC, peerB.peerId),
        ]);
      });
      await faults.measure('tombstone-convergence', async () => {
        await Promise.all(peers.map((peer) => openAppTab(peer.page, 'Feed', '/feed')));
        await Promise.all(
          peers.map((peer) =>
            expect(peer.page.getByText('partition-post-from-a', { exact: true })).toBeHidden({
              timeout: 45_000,
            }),
          ),
        );
        await expect
          .poll(
            async () => {
              const states = await Promise.all(
                peers.map((peer) => readStoredPostState(peer.page, deletedPostId)),
              );
              return (
                states.every(
                  (state) =>
                    state?.deleted === true &&
                    state.revision === 2 &&
                    typeof state.previousRevisionHash === 'string',
                ) && new Set(states.map((state) => JSON.stringify(state))).size === 1
              );
            },
            { timeout: 45_000 },
          )
          .toBe(true);
      });

      await Promise.all([
        expectSessionCount(peerA.page, 1),
        expectSessionCount(peerB.page, 2),
        expectSessionCount(peerC.page, 2),
        expectSessionCount(peerD.page, 1),
      ]);
    } finally {
      await faults.attachManifest(testInfo, peers);
      await closeMeshPeers(peers);
    }
  });
});
