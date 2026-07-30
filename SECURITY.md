# Security Policy

Synpeer is an experimental alpha. It is not suitable for sensitive or
irreplaceable data and does not currently provide a production security
guarantee.

## Supported Versions

Only the latest revision of the default development branch receives security
fixes. There are no supported stable releases yet.

## Reporting a Vulnerability

Do not open a public issue for an unpatched vulnerability.

Use GitHub Private Vulnerability Reporting for this repository when it is
enabled. If that channel is unavailable, contact a maintainer privately before
sharing exploit details. Include:

- affected commit or version;
- affected platform and browser;
- minimal reproduction steps;
- expected impact;
- whether identity material, chat plaintext or remote code execution is
  involved;
- a proposed fix, when available.

The project currently has no paid bug bounty and response times are best effort.
Maintainers should acknowledge a complete report, reproduce it privately and
coordinate disclosure after a fix is available.

## High-Priority Findings

Please report these privately:

- extraction or remote disclosure of private identity key material;
- forged identity, profile, post, receipt or protocol signatures;
- decryption of destination-encrypted chat by an intermediate relay;
- replay or deduplication bypass with durable effects;
- arbitrary code execution through downloaded media or files;
- signaling that permits unauthorized session takeover;
- cross-peer data corruption or deletion;
- committed credentials, Supabase secret/service-role keys or TURN secrets.

## Current Security Limitations

- Local identity key material is not yet protected by strong encryption at
  rest.
- Identity backups contain private key material and are not encrypted. The
  checksum provides corruption detection only.
- The protocol and cryptographic composition have not had an independent audit.
- Browser compromise, malicious extensions and XSS can bypass local
  confidentiality.
- Signaling and relay metadata are not designed to provide anonymity.
- Files received from peers are untrusted and must never be executed
  automatically.

See [docs/security/threat-model.md](docs/security/threat-model.md) for the full
model.

## Credential Hygiene

- Commit `.env.example`, never `.env`.
- Client builds may contain Supabase publishable/anon configuration.
- Never place Supabase `service_role`, secret keys, private identity backups,
  TURN shared secrets or private certificates in client code.
- Run `npm run security:scan` before pushing.
- If a secret reaches Git history, revoke it first and then remove it from the
  complete history. Deleting it only from the latest commit is insufficient.
