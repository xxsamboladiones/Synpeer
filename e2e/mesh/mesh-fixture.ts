import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const SIGNALING_URL = 'ws://127.0.0.1:8797';

type BrowserDatabase = {
  objectStoreNames: ArrayLike<string>;
  transaction(
    storeName: string,
    mode: 'readonly',
  ): {
    objectStore(name: string): {
      getAll(): {
        result: unknown[];
        error: unknown;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
      };
    };
  };
  close(): void;
};

export type MeshPeer = {
  label: string;
  context: BrowserContext;
  page: Page;
  peerId: string;
  invite: string;
  diagnostics: string[];
};

export type StoredPostState = {
  id: string;
  deleted: boolean;
  revision?: number;
  previousRevisionHash?: string;
  contentHash: string;
  signature: string;
};

export const LINEAR_MESH_TOPOLOGY = ['A-B', 'B-C', 'C-D'] as const;

export async function createMeshPeer(browser: Browser, label: string): Promise<MeshPeer> {
  const context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await context.addInitScript(
    ({ signalingUrl }) => {
      Object.assign(globalThis, {
        __SYNPEER_SIGNALING_URL__: signalingUrl,
        __SYNPEER_SUPABASE_URL__: '',
        __SYNPEER_SUPABASE_ANON_KEY__: '',
        __SYNPEER_LOG_LEVEL__: 'debug',
      });
    },
    { signalingUrl: SIGNALING_URL },
  );

  const page = await context.newPage();
  const diagnostics: string[] = [];
  attachPageDiagnostics(page, diagnostics);

  await page.goto('/identity/create');
  await page.getByPlaceholder('Seu nome publico').fill(`Peer ${label}`);
  await page.getByRole('button', { name: 'Criar identidade' }).click();
  await page.waitForURL(/\/feed$/);

  const invite = await copyPeerInvite(page);
  return {
    label,
    context,
    page,
    peerId: getPeerIdFromInvite(invite),
    invite,
    diagnostics,
  };
}

export async function createConnectedLinearMesh(browser: Browser): Promise<MeshPeer[]> {
  const peers: MeshPeer[] = [];
  for (const label of ['A', 'B', 'C', 'D']) {
    peers.push(await createMeshPeer(browser, label));
  }
  const [peerA, peerB, peerC, peerD] = peers;

  await Promise.all([
    importPeerInvite(peerA.page, peerB.invite),
    (async () => {
      await importPeerInvite(peerB.page, peerA.invite);
      await importPeerInvite(peerB.page, peerC.invite);
    })(),
    (async () => {
      await importPeerInvite(peerC.page, peerB.invite);
      await importPeerInvite(peerC.page, peerD.invite);
    })(),
    importPeerInvite(peerD.page, peerC.invite),
  ]);

  await Promise.all(peers.map((peer) => peer.page.goto('/peers')));
  await Promise.all([connectPeer(peerA.page, peerB.peerId), connectPeer(peerB.page, peerA.peerId)]);
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

  return peers;
}

export async function reopenMeshPeer(peer: MeshPeer): Promise<void> {
  if (!peer.page.isClosed()) {
    await peer.page.close();
  }
  const page = await peer.context.newPage();
  attachPageDiagnostics(page, peer.diagnostics);
  peer.page = page;
  await page.goto('/peers');
  await expect(page.getByText('Trusted Peers', { exact: true })).toBeVisible();
}

function attachPageDiagnostics(page: Page, diagnostics: string[]): void {
  page.on('console', (message) => {
    if (!message.text().includes('Download the React DevTools')) {
      diagnostics.push(`[${message.type()}] ${message.text()}`);
      if (diagnostics.length > 500) {
        diagnostics.shift();
      }
    }
  });
  page.on('pageerror', (error) => {
    diagnostics.push(`[pageerror] ${error.message}`);
  });
  page.on('dialog', (dialog) => {
    void dialog.accept();
  });
}

export async function copyPeerInvite(page: Page): Promise<string> {
  await page.goto('/network');
  await expect(page.getByText('Network Status')).toBeVisible();
  await page.getByTestId('copy-peer-invite').click();
  await expect
    .poll(() => page.evaluate(() => globalThis.navigator.clipboard.readText()))
    .toMatch(/^synpeer:peer\?/);
  return page.evaluate(() => globalThis.navigator.clipboard.readText());
}

export async function importPeerInvite(page: Page, invite: string): Promise<void> {
  await page.goto('/network');
  await page.getByPlaceholder('synpeer:peer?v=1&peerId=...').fill(invite);
  await page.getByTestId('import-peer-invite').click();
}

export async function connectPeer(page: Page, peerId: string): Promise<void> {
  await expect
    .poll(async () => {
      const response = await page.request.get('http://127.0.0.1:8797/peers');
      const payload = (await response.json()) as { peers?: string[] };
      return payload.peers ?? [];
    })
    .toContain(peerId);
  const button = page.getByTestId(`peer-connect-${peerId}`);
  await expect(button).toBeVisible();
  await button.click();
}

export async function expectPeerConnected(peer: MeshPeer, peerId: string): Promise<void> {
  try {
    await expect(peer.page.getByTestId(`peer-state-${peerId}`)).toContainText('online', {
      timeout: 30_000,
    });
  } catch (error) {
    const recentDiagnostics = peer.diagnostics.slice(-100).join('\n');
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`Peer ${peer.label} did not connect.\n${cause}\n${recentDiagnostics}`);
  }
}

export async function expectSessionCount(page: Page, expected: number): Promise<void> {
  await expect(page.getByTestId('peer-webrtc-session-count')).toContainText(String(expected), {
    timeout: 30_000,
  });
}

export async function openAppTab(page: Page, label: string, pathname: string): Promise<void> {
  await page.getByRole('tab', { name: new RegExp(`${escapeRegExp(label)}$`) }).click();
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(pathname)}$`));
}

export async function publishTextPost(page: Page, content: string): Promise<void> {
  await openAppTab(page, 'Feed', '/feed');
  await page.getByTestId('feed-post-composer').fill(content);
  await page.getByTestId('feed-publish-post').click();
  await expect(page.getByText(content, { exact: true })).toBeVisible();
}

export async function getPostIdByText(page: Page, content: string): Promise<string> {
  const text = page.getByText(content, { exact: true }).first();
  const card = text.locator('xpath=ancestor::*[starts-with(@data-testid, "post-card-")]').first();
  const testId = await card.getAttribute('data-testid');
  if (!testId?.startsWith('post-card-')) {
    throw new Error(`Could not resolve post id for "${content}"`);
  }
  return testId.slice('post-card-'.length);
}

export async function deleteOwnedPost(page: Page, postId: string): Promise<void> {
  const card = page.getByTestId(`post-card-${postId}`);
  await expect(card).toBeVisible();
  await card.getByTestId(`post-delete-${postId}`).click();
  await expect(card).toBeHidden();
}

export async function readStoredPostState(
  page: Page,
  postId: string,
): Promise<StoredPostState | null> {
  return await page.evaluate(async (id) => {
    const database = await new Promise<BrowserDatabase>((resolve, reject) => {
      const request = globalThis.indexedDB.open('insta99.db');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const transaction = database.transaction('posts', 'readonly');
        const request = transaction.objectStore('posts').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const row = rows.find(
        (candidate) =>
          typeof candidate === 'object' &&
          candidate !== null &&
          Reflect.get(candidate, 'id') === id,
      );
      if (typeof row !== 'object' || row === null) {
        return null;
      }
      return {
        id: String(Reflect.get(row, 'id')),
        deleted: Reflect.get(row, 'deleted') === true || Number(Reflect.get(row, 'deleted')) === 1,
        revision:
          typeof Reflect.get(row, 'revision') === 'number'
            ? Number(Reflect.get(row, 'revision'))
            : undefined,
        previousRevisionHash:
          typeof Reflect.get(row, 'previousRevisionHash') === 'string'
            ? String(Reflect.get(row, 'previousRevisionHash'))
            : undefined,
        contentHash: String(Reflect.get(row, 'contentHash')),
        signature: String(Reflect.get(row, 'signature')),
      };
    } finally {
      database.close();
    }
  }, postId);
}

export async function expectPlaintextAbsentFromStorage(
  page: Page,
  plaintext: string,
): Promise<void> {
  const containsPlaintext = await page.evaluate(async (needle) => {
    const localValues = Array.from({ length: globalThis.localStorage.length }, (_, index) =>
      globalThis.localStorage.key(index),
    )
      .filter((key): key is string => Boolean(key))
      .map((key) => globalThis.localStorage.getItem(key));
    if (JSON.stringify(localValues).includes(needle)) {
      return true;
    }

    const database = await new Promise<BrowserDatabase>((resolve, reject) => {
      const request = globalThis.indexedDB.open('insta99.db');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const storeNames = Array.from(database.objectStoreNames);
      const rows = await Promise.all(
        storeNames.map(
          (storeName) =>
            new Promise<unknown[]>((resolve, reject) => {
              const transaction = database.transaction(storeName, 'readonly');
              const request = transaction.objectStore(storeName).getAll();
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            }),
        ),
      );
      return JSON.stringify(rows).includes(needle);
    } finally {
      database.close();
    }
  }, plaintext);

  expect(containsPlaintext).toBe(false);
}

export async function closeMeshPeers(peers: MeshPeer[]): Promise<void> {
  await Promise.all(peers.map((peer) => peer.context.close()));
}

function getPeerIdFromInvite(invite: string): string {
  const queryIndex = invite.indexOf('?');
  const peerId = new globalThis.URLSearchParams(invite.slice(queryIndex + 1)).get('peerId');
  if (!peerId) {
    throw new Error(`Peer invite does not contain a peerId: ${invite}`);
  }
  return peerId;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
