import { expect, test } from '@playwright/test';
import { Buffer } from 'node:buffer';

import {
  closeMeshPeers,
  connectPeer,
  createMeshPeer,
  expectPlaintextAbsentFromStorage,
  expectPeerConnected,
  expectSessionCount,
  importPeerInvite,
  openAppTab,
  reopenMeshPeer,
  type MeshPeer,
} from './mesh-fixture';

test.describe('four-peer WebRTC mesh', () => {
  test('creates isolated identities and a single A-B-C-D chain', async ({ browser }) => {
    const peers: MeshPeer[] = [];

    try {
      for (const label of ['A', 'B', 'C', 'D']) {
        peers.push(await createMeshPeer(browser, label));
      }
      const [peerA, peerB, peerC, peerD] = peers;

      expect(new Set(peers.map((peer) => peer.peerId)).size).toBe(4);
      const signalingHealth = await peerA.page.request.get('http://127.0.0.1:8797/health');
      expect(signalingHealth.ok()).toBe(true);
      expect((await signalingHealth.json()).peers).toBe(4);

      await Promise.all([
        importPeerInvite(peerA.page, peerB.invite),
        importPeerInvite(peerB.page, peerA.invite),
        importPeerInvite(peerC.page, peerB.invite),
        importPeerInvite(peerD.page, peerC.invite),
      ]);
      await Promise.all([
        importPeerInvite(peerB.page, peerC.invite),
        importPeerInvite(peerC.page, peerD.invite),
      ]);

      await Promise.all(peers.map((peer) => peer.page.goto('/peers')));
      await Promise.all([
        connectPeer(peerA.page, peerB.peerId),
        connectPeer(peerB.page, peerA.peerId),
      ]);
      await Promise.all([
        expectPeerConnected(peerA, peerB.peerId),
        expectPeerConnected(peerB, peerA.peerId),
      ]);

      await connectPeer(peerB.page, peerC.peerId);
      await Promise.all([
        expectPeerConnected(peerB, peerC.peerId),
        expectPeerConnected(peerC, peerB.peerId),
      ]);

      await connectPeer(peerC.page, peerD.peerId);
      await Promise.all([
        expectPeerConnected(peerC, peerD.peerId),
        expectPeerConnected(peerD, peerC.peerId),
      ]);

      await Promise.all([
        expectSessionCount(peerA.page, 1),
        expectSessionCount(peerB.page, 2),
        expectSessionCount(peerC.page, 2),
        expectSessionCount(peerD.page, 1),
      ]);

      await peerB.page.reload();
      await Promise.all([
        expectPeerConnected(peerA, peerB.peerId),
        expectPeerConnected(peerB, peerA.peerId),
        expectPeerConnected(peerB, peerC.peerId),
        expectPeerConnected(peerC, peerB.peerId),
      ]);
      await Promise.all([
        expectSessionCount(peerA.page, 1),
        expectSessionCount(peerB.page, 2),
        expectSessionCount(peerC.page, 2),
      ]);

      await peerD.page.close();
      await openAppTab(peerA.page, 'Feed', '/feed');
      await peerA.page.getByTestId('feed-post-composer').fill('mesh-post-v1');
      await peerA.page.getByTestId('feed-publish-post').click();
      await expect(peerA.page.getByText('mesh-post-v1', { exact: true })).toBeVisible();

      await reopenMeshPeer(peerD);
      await Promise.all([
        expectPeerConnected(peerC, peerD.peerId),
        expectPeerConnected(peerD, peerC.peerId),
      ]);
      await Promise.all([expectSessionCount(peerC.page, 2), expectSessionCount(peerD.page, 1)]);

      await openAppTab(peerD.page, 'Feed', '/feed');
      await expect(peerD.page.getByText('mesh-post-v1', { exact: true })).toBeVisible({
        timeout: 45_000,
      });

      await peerA.page.locator('[data-testid^="post-edit-"]').click();
      await peerA.page.locator('[data-testid^="post-edit-input-"]').fill('mesh-post-v2');
      await peerA.page.locator('[data-testid^="post-save-edit-"]').click();
      await expect(peerD.page.getByText('mesh-post-v2', { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(peerD.page.getByText('mesh-post-v1', { exact: true })).toHaveCount(0);

      await peerA.page.locator('[data-testid^="post-delete-"]').click();
      await expect(peerD.page.getByText('mesh-post-v2', { exact: true })).toHaveCount(0, {
        timeout: 30_000,
      });

      await openAppTab(peerA.page, 'Discover', '/discover');
      const followPeerD = peerA.page.getByTestId(`discover-follow-${peerD.peerId}`);
      await expect(followPeerD).toBeVisible();
      await followPeerD.click();
      await expect(followPeerD).toContainText('Unfollow');

      await Promise.all([
        openAppTab(peerA.page, 'Mensagens', '/chat'),
        openAppTab(peerD.page, 'Mensagens', '/chat'),
      ]);
      await expect(peerA.page.getByTestId(`chat-peer-${peerD.peerId}`)).toBeVisible({
        timeout: 30_000,
      });
      await expect(peerD.page.getByTestId(`chat-peer-${peerA.peerId}`)).toBeVisible({
        timeout: 30_000,
      });
      await peerA.page.getByTestId(`chat-peer-${peerD.peerId}`).click();
      await peerD.page.getByTestId(`chat-peer-${peerA.peerId}`).click();

      const privateMessage = 'mesh-private-message-a-to-d';
      await peerA.page.getByTestId('chat-message-input').fill(privateMessage);
      await peerA.page.getByTestId('chat-send').click();
      await expect(peerD.page.getByText(privateMessage, { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        peerA.page.locator('[data-testid^="chat-message-"]').filter({ hasText: privateMessage }),
      ).toContainText('lida', { timeout: 30_000 });

      await Promise.all([
        expectPlaintextAbsentFromStorage(peerB.page, privateMessage),
        expectPlaintextAbsentFromStorage(peerC.page, privateMessage),
      ]);

      await openAppTab(peerD.page, 'Feed', '/feed');
      await openAppTab(peerA.page, 'Create', '/create');
      await peerA.page.getByTestId('create-post-composer').fill('mesh-media-post');
      const fileChooserPromise = peerA.page.waitForEvent('filechooser');
      await peerA.page.getByTestId('create-attachment-image').click();
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles({
        name: 'mesh-pixel.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlQAAAABJRU5ErkJggg==',
          'base64',
        ),
      });
      const attachmentQueue = peerA.page.getByTestId('create-upload-queue');
      await expect(attachmentQueue).toContainText('mesh-pixel.png');
      await expect(attachmentQueue).toContainText('ready');
      await peerA.page.getByTestId('create-post-submit').click();

      const remoteMediaPost = peerD.page
        .locator('[data-testid^="post-card-"]')
        .filter({ hasText: 'mesh-media-post' });
      await expect(remoteMediaPost).toBeVisible({ timeout: 45_000 });
      await expect(remoteMediaPost).toContainText('mesh-pixel.png');
      await expect(remoteMediaPost).toContainText('Available', { timeout: 45_000 });
      await expect
        .poll(async () => {
          const image = remoteMediaPost.locator('img').first();
          if ((await image.count()) === 0) {
            return 0;
          }
          return await image.evaluate((element) => element.naturalWidth);
        })
        .toBeGreaterThan(0);
    } finally {
      await closeMeshPeers(peers);
    }
  });
});
