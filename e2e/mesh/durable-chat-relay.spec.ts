import { expect, test } from '@playwright/test';

import { MeshFaultController } from './mesh-fault-controller';
import {
  closeMeshPeers,
  createConnectedLinearMesh,
  expectPeerConnected,
  expectPlaintextAbsentFromStorage,
  LINEAR_MESH_TOPOLOGY,
  openAppTab,
  type MeshPeer,
} from './mesh-fixture';

test.describe('durable multi-hop chat delivery', () => {
  test('resumes after sender reload and an offline relay returns', async ({
    browser,
  }, testInfo) => {
    const peers: MeshPeer[] = [];
    const plaintext = 'durable-message-across-offline-relay';
    const faults = new MeshFaultController(
      'durable-chat-relay-recovery',
      15003,
      LINEAR_MESH_TOPOLOGY,
    );

    try {
      peers.push(
        ...(await faults.measure('mesh-bootstrap', () => createConnectedLinearMesh(browser))),
      );
      const [peerA, peerB, peerC, peerD] = peers;

      await peerA.page.goto(`/profile/${peerD.peerId}`);
      await peerA.page.getByRole('button', { name: 'Seguir', exact: true }).click();
      await expect(
        peerA.page.getByRole('button', { name: 'Deixar de seguir', exact: true }),
      ).toBeVisible();

      await openAppTab(peerD.page, 'Mensagens', '/chat');
      await expect(peerD.page.getByTestId(`chat-peer-${peerA.peerId}`)).toBeVisible({
        timeout: 30_000,
      });

      await faults.partitionPeer(peerB);
      await openAppTab(peerA.page, 'Mensagens', '/chat');
      await peerA.page.getByTestId(`chat-peer-${peerD.peerId}`).click();
      await peerA.page.getByTestId('chat-message-input').fill(plaintext);
      await peerA.page.getByTestId('chat-send').click();
      await expect(peerA.page.getByText(plaintext, { exact: true })).toBeVisible();
      await expect(
        peerA.page.getByText('Voce - aguardando entrega', { exact: true }),
      ).toBeVisible();

      await peerA.page.reload();
      await expect(peerA.page.getByTestId(`chat-peer-${peerD.peerId}`)).toBeVisible();
      await peerA.page.getByTestId(`chat-peer-${peerD.peerId}`).click();
      await expect(peerA.page.getByText(plaintext, { exact: true })).toBeVisible();

      await faults.restorePeer(peerB);
      await Promise.all([
        peerA.page.goto('/peers'),
        peerB.page.goto('/peers'),
        peerC.page.goto('/peers'),
      ]);
      await faults.measure('relay-reconnect', async () => {
        await Promise.all([
          expectPeerConnected(peerA, peerB.peerId),
          expectPeerConnected(peerB, peerA.peerId),
          expectPeerConnected(peerB, peerC.peerId),
          expectPeerConnected(peerC, peerB.peerId),
        ]);
      });

      await faults.measure('chat-delivery', async () => {
        await openAppTab(peerD.page, 'Mensagens', '/chat');
        await peerD.page.getByTestId(`chat-peer-${peerA.peerId}`).click();
        await expect(peerD.page.getByText(plaintext, { exact: true })).toHaveCount(1, {
          timeout: 45_000,
        });

        await openAppTab(peerA.page, 'Mensagens', '/chat');
        await peerA.page.getByTestId(`chat-peer-${peerD.peerId}`).click();
        await expect(peerA.page.getByText(/^Voce - (entregue|lida)$/)).toBeVisible({
          timeout: 45_000,
        });
      });

      await Promise.all([
        expectPlaintextAbsentFromStorage(peerB.page, plaintext),
        expectPlaintextAbsentFromStorage(peerC.page, plaintext),
      ]);
    } finally {
      await faults.attachManifest(testInfo, peers);
      await closeMeshPeers(peers);
    }
  });
});
