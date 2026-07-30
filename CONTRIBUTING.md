# Contributing to Synpeer

Synpeer welcomes focused bug fixes, reproducible network reports, protocol
review, tests and documentation improvements.

## Setup

```bash
npm ci
copy .env.example .env
npm run web
```

Supabase is optional. Without remote signaling, same-browser testing can use
BroadcastChannel and LAN testing can use `npm run signaling`.

## Development Rules

- Keep domain logic independent from React and platform APIs.
- Validate all data received from storage, routes, clipboard and the network.
- Do not add simulated success paths or random identifiers.
- Use deterministic IDs and canonical serialization where the protocol
  requires them.
- Preserve signature, replay, TTL, deduplication and size checks.
- Never log private keys, backup contents, plaintext chat payloads or
  credentials.
- Add typed errors and structured logs at application boundaries.
- Include migrations when changing persisted schemas.
- Keep compatibility behavior explicit and time-bounded.

## Before Opening a Pull Request

```bash
npm run security:scan
npm run lint
npm run typecheck
npm test -- --runInBand
npm run export:web
```

For transport, synchronization, chat or media changes:

```bash
npx playwright install chromium
npm run test:e2e:mesh
```

Describe the behavior change, affected protocol versions, persisted-data impact,
failure modes and the tests you ran. Do not weaken tests to make a change pass.

## Protocol Changes

A protocol pull request must document:

- message or entity schema;
- canonical bytes that are signed or hashed;
- size and TTL limits;
- replay and deduplication behavior;
- backward compatibility;
- failure and retry behavior;
- privacy metadata exposed to direct peers, relays and signaling services.

Breaking changes require an explicit protocol-version decision and migration or
rejection strategy.

## Security

Do not disclose vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contribution is licensed under Apache
License 2.0.
