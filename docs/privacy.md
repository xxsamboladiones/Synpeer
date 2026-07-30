# Privacy and External Services

This document describes the current implementation, not a legal privacy policy.

## Local Data

A peer can persist:

- identity key material and public profile;
- trusted-peer records and connection metadata;
- posts, follows, reactions, comments and notifications;
- chat ciphertext/plaintext needed by the local endpoint;
- media metadata, chunks and cache state;
- synchronization cursors, outbox entries and receipts;
- runtime preferences and diagnostic state.

The settings flow provides local reset operations, but users should verify
backups and browser storage behavior before relying on destructive reset.

## Supabase

When configured, Synpeer uses Supabase Realtime for:

- peer presence;
- private-network coordination;
- addressed WebRTC offers and answers.

The adapter does not intentionally write posts, chat bodies, media or identity
private keys to Supabase Postgres or Storage. No SQL schema is required by the
current implementation.

Supabase and the operator of the configured project can still observe network
metadata, peer identifiers, channel activity, timestamps and SDP/ICE signaling
payloads. Provider-side logs and retention are outside the client code's
control.

Only publishable/anon client credentials belong in the app. A Supabase
`service_role` or secret key must never be embedded in a client build.

## Self-Hosted Signaling

The included WebSocket server keeps connected peer IDs, private-network
membership and pending signaling messages in memory. It exposes diagnostic
HTTP endpoints and is not authenticated or hardened for public Internet
deployment.

Its process memory is cleared on restart. Server, reverse-proxy and host logs may
still retain metadata.

## WebRTC, STUN and TURN

WebRTC establishes the DataChannel used for protocol traffic. STUN providers can
observe connection metadata. If TURN is used, the TURN server relays encrypted
WebRTC packets and can observe endpoints, timing and volume even though the
DataChannel transport remains encrypted.

## Peer Relays

Intermediate Synpeer peers can observe routing metadata, peer identifiers,
message timing, size and ciphertext. Destination-encrypted chat bodies are not
intended to be readable by relays. Other replicated social content may be
readable because it is designed for distribution.

## Telemetry

The current repository does not intentionally integrate advertising analytics
or a remote product-telemetry service. Structured logs are emitted locally.
Dependencies, browsers, operating systems and infrastructure providers can have
their own diagnostics or policies.

## Backups

Identity backups contain private key material. They are not encrypted. Treat
them as highly sensitive secrets, store them offline and never attach them to an
issue or commit them to Git.
