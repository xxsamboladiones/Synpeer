#!/usr/bin/env node
/* global Buffer, URL, console, process, require */

const crypto = require('node:crypto');
const http = require('node:http');

const PORT = Number(
  process.env.SYNPEER_SIGNALING_PORT ??
    process.env.INSTA99_SIGNALING_PORT ??
    process.env.PORT ??
    8787,
);
const HOST = process.env.SYNPEER_SIGNALING_HOST ?? process.env.INSTA99_SIGNALING_HOST ?? '0.0.0.0';
const MAX_FRAME_BYTES = 256 * 1024;
const PENDING_TTL_MS = 2 * 60 * 1000;

const peers = new Map();
const pendingSignals = new Map();
const networks = new Map();

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, {
      status: 'ok',
      peers: peers.size,
      networks: networks.size,
      pending: Array.from(pendingSignals.values()).reduce(
        (total, items) => total + items.length,
        0,
      ),
      uptimeMs: Math.round(process.uptime() * 1000),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/peers') {
    sendJson(response, 200, {
      peers: Array.from(peers.keys()),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/networks') {
    sendJson(response, 200, {
      networks: Array.from(networks.values()).map((network) => serializeNetwork(network)),
    });
    return;
  }

  sendJson(response, 404, { error: 'not_found' });
});

server.on('upgrade', (request, socket) => {
  if (!isWebSocketUpgrade(request)) {
    socket.destroy();
    return;
  }

  const acceptKey = createAcceptKey(request.headers['sec-websocket-key']);
  if (!acceptKey) {
    socket.destroy();
    return;
  }

  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '',
      '',
    ].join('\r\n'),
  );

  attachSocket(socket);
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const printable =
    typeof address === 'object' && address
      ? `${address.address}:${address.port}`
      : `${HOST}:${PORT}`;
  console.log(`[synpeer-signaling] listening on ${printable}`);
});

function attachSocket(socket) {
  let peerId = null;
  let networkId = null;
  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length > 0) {
      const decoded = decodeFrame(buffer);
      if (!decoded) {
        return;
      }
      buffer = buffer.subarray(decoded.bytesRead);
      if (decoded.opcode === 0x8) {
        socket.end();
        return;
      }
      if (decoded.opcode !== 0x1) {
        continue;
      }
      const message = parseJson(decoded.payload.toString('utf8'));
      if (!message) {
        continue;
      }
      const nextPeerId = handleClientMessage(socket, message, peerId);
      if (nextPeerId) {
        peerId = nextPeerId;
      }
      if (typeof message.networkId === 'string') {
        networkId = message.networkId;
      }
    }
  });

  socket.on('close', () => {
    if (peerId && peers.get(peerId) === socket) {
      peers.delete(peerId);
      broadcastPresence(peerId, false, networkId);
    }
  });

  socket.on('error', () => {
    if (peerId && peers.get(peerId) === socket) {
      peers.delete(peerId);
      broadcastPresence(peerId, false, networkId);
    }
  });
}

function handleClientMessage(socket, message, currentPeerId) {
  if (message.kind === 'hello' && message.version === 1 && typeof message.peerId === 'string') {
    peers.set(message.peerId, socket);
    flushPending(message.peerId, socket);
    sendFrame(socket, JSON.stringify({ kind: 'hello-ack', version: 1, peerId: message.peerId }));
    return message.peerId;
  }

  if (message.kind === 'network-create') {
    handleNetworkCreate(socket, message, currentPeerId);
    return currentPeerId;
  }

  if (message.kind === 'network-join') {
    handleNetworkJoin(socket, message, currentPeerId);
    return currentPeerId;
  }

  if (message.kind === 'network-approve') {
    handleNetworkApprove(socket, message, currentPeerId);
    return currentPeerId;
  }

  if (message.kind !== 'signal' || !isSignalMessage(message.message)) {
    return currentPeerId;
  }

  const signal = message.message;
  if (!currentPeerId || signal.fromPeerId !== currentPeerId) {
    sendFrame(
      socket,
      JSON.stringify({
        kind: 'error',
        code: 'sender_mismatch',
        message: 'Signal sender must match the registered peer.',
      }),
    );
    return currentPeerId;
  }

  const target = peers.get(signal.toPeerId);
  if (target) {
    sendFrame(target, JSON.stringify({ kind: 'signal', message: signal }));
  } else {
    queuePendingSignal(signal);
  }
  sendFrame(socket, JSON.stringify({ kind: 'signal-ack', id: signal.id }));
  return currentPeerId;
}

function handleNetworkCreate(socket, message, currentPeerId) {
  if (
    !currentPeerId ||
    message.version !== 1 ||
    typeof message.networkId !== 'string' ||
    typeof message.name !== 'string'
  ) {
    sendFrame(socket, JSON.stringify({ kind: 'error', code: 'invalid_network_create' }));
    return;
  }

  const network = networks.get(message.networkId) ?? {
    networkId: message.networkId,
    name: message.name,
    ownerPeerId: currentPeerId,
    createdAt: Date.now(),
    members: new Map(),
  };

  network.members.set(currentPeerId, {
    peerId: currentPeerId,
    status: 'approved',
    online: true,
    updatedAt: Date.now(),
  });
  networks.set(network.networkId, network);
  socket.networkId = network.networkId;
  sendNetworkUpdate(network);
}

function handleNetworkJoin(socket, message, currentPeerId) {
  if (
    !currentPeerId ||
    message.version !== 1 ||
    typeof message.networkId !== 'string' ||
    typeof message.name !== 'string'
  ) {
    sendFrame(socket, JSON.stringify({ kind: 'error', code: 'invalid_network_join' }));
    return;
  }

  const network = networks.get(message.networkId) ?? {
    networkId: message.networkId,
    name: message.name,
    ownerPeerId: typeof message.ownerPeerId === 'string' ? message.ownerPeerId : currentPeerId,
    createdAt: Date.now(),
    members: new Map(),
  };
  const existing = network.members.get(currentPeerId);
  const isOwner = network.ownerPeerId === currentPeerId;
  network.members.set(currentPeerId, {
    peerId: currentPeerId,
    status: existing?.status ?? (isOwner ? 'approved' : 'pending'),
    online: true,
    updatedAt: Date.now(),
  });
  networks.set(network.networkId, network);
  socket.networkId = network.networkId;
  sendNetworkUpdate(network);
}

function handleNetworkApprove(socket, message, currentPeerId) {
  if (
    !currentPeerId ||
    message.version !== 1 ||
    typeof message.networkId !== 'string' ||
    typeof message.peerId !== 'string'
  ) {
    sendFrame(socket, JSON.stringify({ kind: 'error', code: 'invalid_network_approve' }));
    return;
  }

  const network = networks.get(message.networkId);
  const actor = network?.members.get(currentPeerId);
  if (!network || (network.ownerPeerId !== currentPeerId && actor?.status !== 'approved')) {
    sendFrame(socket, JSON.stringify({ kind: 'error', code: 'network_approval_denied' }));
    return;
  }

  const existing = network.members.get(message.peerId) ?? {
    peerId: message.peerId,
    online: peers.has(message.peerId),
    updatedAt: Date.now(),
  };
  network.members.set(message.peerId, {
    ...existing,
    status: 'approved',
    online: peers.has(message.peerId),
    updatedAt: Date.now(),
  });
  sendNetworkUpdate(network);
}

function broadcastPresence(peerId, online, networkId) {
  if (!networkId) {
    return;
  }
  const network = networks.get(networkId);
  const member = network?.members.get(peerId);
  if (!network || !member) {
    return;
  }
  network.members.set(peerId, {
    ...member,
    online,
    updatedAt: Date.now(),
  });
  sendNetworkUpdate(network);
}

function sendNetworkUpdate(network) {
  const payload = JSON.stringify({ kind: 'network-update', network: serializeNetwork(network) });
  for (const member of network.members.values()) {
    const socket = peers.get(member.peerId);
    if (socket) {
      sendFrame(socket, payload);
    }
  }
}

function serializeNetwork(network) {
  return {
    networkId: network.networkId,
    name: network.name,
    ownerPeerId: network.ownerPeerId,
    createdAt: network.createdAt,
    members: Array.from(network.members.values()),
  };
}

function isSignalMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return (
    value.version === 1 &&
    typeof value.id === 'string' &&
    (value.type === 'offer' || value.type === 'answer') &&
    typeof value.fromPeerId === 'string' &&
    typeof value.toPeerId === 'string' &&
    typeof value.code === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.expiresAt === 'number' &&
    value.expiresAt >= Date.now()
  );
}

function queuePendingSignal(signal) {
  prunePending();
  const current = pendingSignals.get(signal.toPeerId) ?? [];
  current.push(signal);
  pendingSignals.set(signal.toPeerId, current);
}

function flushPending(peerId, socket) {
  prunePending();
  const current = pendingSignals.get(peerId) ?? [];
  pendingSignals.delete(peerId);
  for (const signal of current) {
    sendFrame(socket, JSON.stringify({ kind: 'signal', message: signal }));
  }
}

function prunePending() {
  const now = Date.now();
  for (const [peerId, signals] of pendingSignals.entries()) {
    const fresh = signals.filter(
      (signal) => signal.expiresAt >= now && signal.createdAt + PENDING_TTL_MS >= now,
    );
    if (fresh.length > 0) {
      pendingSignals.set(peerId, fresh);
    } else {
      pendingSignals.delete(peerId);
    }
  }
}

function isWebSocketUpgrade(request) {
  return (
    request.headers.upgrade?.toLowerCase() === 'websocket' &&
    request.headers.connection?.toLowerCase().includes('upgrade')
  );
}

function createAcceptKey(key) {
  if (typeof key !== 'string') {
    return null;
  }
  return crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

function decodeFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) === 0x80;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    length = high * 2 ** 32 + low;
    offset += 8;
  }

  if (length > MAX_FRAME_BYTES) {
    return { opcode: 0x8, payload: Buffer.alloc(0), bytesRead: buffer.length };
  }

  const maskOffset = masked ? 4 : 0;
  if (buffer.length < offset + maskOffset + length) {
    return null;
  }

  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  offset += maskOffset;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }

  return {
    opcode,
    payload,
    bytesRead: offset + length,
  };
}

function sendFrame(socket, data) {
  const payload = Buffer.from(data);
  if (payload.length > MAX_FRAME_BYTES) {
    return;
  }

  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(payload.length, 6);
  }
  socket.write(Buffer.concat([header, payload]));
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  response.end(JSON.stringify(payload));
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
