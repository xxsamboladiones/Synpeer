# Open-Source Alpha Release Checklist

This checklist prevents documentation claims from getting ahead of reproducible
code.

## Repository

- [x] Official project name is Synpeer in app/package configuration.
- [x] Apache License 2.0 is present.
- [x] README, contribution and security guidance are present.
- [x] `.env.example` contains placeholders only and is not ignored.
- [x] Local `.env` files are ignored.
- [ ] Review every untracked and modified file before the first public commit.
- [ ] Reproduce the project from a clean clone of the published commit.
- [x] GitHub destination and package links use
      `https://github.com/xxsamboladiones/Synpeer`.

## Secrets

- [x] Current high-risk credential scan is available as
      `npm run security:scan`.
- [ ] Scan the complete Git history with a dedicated history scanner.
- [ ] Confirm no identity backup, IndexedDB dump, TURN secret or private
      certificate exists in any commit.
- [ ] Enable repository secret scanning and push protection where available.
- [ ] Revoke any credential that was ever committed before rewriting history.
- [ ] Resolve or formally assess the remaining transitive `npm audit`
      advisories without accepting the incompatible forced Expo/toolchain
      changes.

## Security and Privacy

- [x] Threat model documents current guarantees and non-guarantees.
- [x] Supabase is described as Realtime signaling/presence, not social storage.
- [x] TURN and peer-relay metadata exposure is documented.
- [x] Unencrypted local identity/backup limitation is documented.
- [ ] Encrypt identity keys and backups before recommending sensitive use.
- [ ] Enable GitHub Private Vulnerability Reporting.
- [ ] Obtain external cryptographic/protocol review before a stable release.

## Reproducibility

- [x] Two-peer and four-peer demo procedures are documented.
- [x] Lint, typecheck, unit/integration and web export commands are documented.
- [x] CI workflow validates the supported Node/runtime path.
- [ ] Run repeated mesh tests from the final public commit.
- [ ] Run a documented two-computer test outside the development LAN.
- [ ] Validate at least one TURN-required connection.
- [ ] Publish sanitized screenshots and a short demo video.
- [ ] Normalize the pre-existing repository-wide Prettier debt so
      `npm run format:check` passes without touching unrelated behavior.

## Product Limits

- [ ] Complete signed media availability and malicious-source quarantine.
- [ ] Complete global backpressure, peer quotas and disk-pressure behavior.
- [ ] Complete media repair and garbage collection.
- [ ] Remove inactive legacy security/protocol modules.
- [ ] Validate native mobile transport to the same level as web.
- [ ] Publish protocol and persisted-schema compatibility policy.

## Release Positioning

Use:

> Operational experimental P2P social network. Not production-ready.

Do not claim anonymity, audited cryptography, guaranteed direct connectivity,
safe executable files or production readiness.
