# Synpeer — Phase 2: Peer-to-Peer Network Foundation

## Goal

Build the first working version of the decentralized network.

At the end of Phase 2, two or more devices must be able to discover each other, establish secure connections, exchange signed messages, synchronize identities, and share small pieces of data without any backend server.

No blockchain.

No cryptocurrency.

No social feed.

No centralized API.

Only the decentralized networking layer.

---

# Technical Goals

- Create a reusable networking layer.
- Integrate libp2p.
- Use cryptographic identities from Phase 1.
- Enable peer discovery.
- Exchange signed messages.
- Build the first synchronization protocol.
- Prepare the foundation for distributed storage.

---

# Architecture

```
src/

network/
    PeerManager.ts
    PeerDiscovery.ts
    PeerConnection.ts
    NetworkEvents.ts
    NetworkTypes.ts

protocols/
    handshake/
    sync/
    ping/
    identity/

services/network/

features/network/

```

---

# Task 1 — Install Networking Stack

## Files

Create:

```
src/network/
```

Install:

- libp2p
- @libp2p/tcp
- @libp2p/websockets
- @libp2p/bootstrap
- @chainsafe/libp2p-noise
- @chainsafe/libp2p-yamux
- multiaddr

Goals

- configure libp2p
- create bootstrap configuration
- prepare transports
- create typed network configuration

Validation

- lint
- typecheck
- tests

Commit

```
feat: add libp2p networking foundation
```

---

# Task 2 — Peer Identity

Reuse CryptoService.

Goals

Every peer identity must be derived from the local cryptographic identity.

No duplicate IDs.

No temporary IDs.

Files

```
src/network/PeerIdentity.ts
```

Validation

- peer id generation
- persistence
- reload

Commit

```
feat: add peer identity
```

---

# Task 3 — Peer Discovery

Goals

Automatically discover peers.

Support:

- bootstrap peers
- local discovery
- reconnect

Files

```
PeerDiscovery.ts
DiscoveryEvents.ts
```

Tests

- peer discovered
- peer removed
- reconnect

Commit

```
feat: add peer discovery
```

---

# Task 4 — Secure Connections

Goals

Connect peers securely.

Handshake.

Encrypted channels.

Automatic reconnect.

Files

```
PeerConnection.ts
```

Tests

- connect
- disconnect
- reconnect

Commit

```
feat: add secure peer connections
```

---

# Task 5 — Network Events

Create event bus.

Events

- peer connected
- peer disconnected
- sync started
- sync finished
- errors

Files

```
NetworkEvents.ts
```

Commit

```
feat: add network event system
```

---

# Task 6 — Ping Protocol

Create the first protocol.

Purpose

Measure latency.

Detect availability.

Files

```
protocols/ping/
```

Tests

- ping
- pong

Commit

```
feat: add ping protocol
```

---

# Task 7 — Identity Synchronization

Purpose

Exchange only public information.

Each peer shares

- public key
- username
- avatar hash
- version

Never exchange private keys.

Protocol

```
IdentityRequest

IdentityResponse
```

Commit

```
feat: add identity sync
```

---

# Task 8 — Signed Messages

Goals

Every network message must contain:

- payload
- timestamp
- sender
- signature

Receiver must verify signature.

Reject invalid packets.

Files

```
SignedPacket.ts
```

Tests

- valid signature
- invalid signature
- replay attempt

Commit

```
feat: add signed network packets
```

---

# Task 9 — Synchronization Protocol

Create first sync protocol.

Capabilities

request data

receive data

version comparison

ignore duplicates

Future-ready for:

- posts
- profiles
- comments

Commit

```
feat: add synchronization protocol
```

---

# Task 10 — Network Monitor

Create developer screen.

Display

Peer ID

Connected peers

Latency

Connection type

Messages sent

Messages received

Network uptime

Reconnect count

Errors

No debug console dependency.

Commit

```
feat: add network monitor
```

---

# Task 11 — Integration

Integrate network lifecycle.

App start

↓

Load identity

↓

Start network

↓

Discover peers

↓

Connect

↓

Exchange identities

↓

Idle

---

# Task 12 — Hardening

Run

- lint
- typecheck
- tests

Review

- memory leaks
- reconnect logic
- event cleanup
- race conditions

Commit

```
chore: harden phase 2 networking
```

---

# Deliverables

At the end of Phase 2:

- Devices discover each other.
- Secure P2P connections work.
- Signed packets are exchanged.
- Public identities synchronize.
- Network monitor shows live status.
- Zero backend servers.
- Zero blockchain.
- Zero social features.

The networking foundation is now ready for building the decentralized social layer in Phase 3.
