# Insta99 Phase 1 Design

## Goal

Build the foundation for Insta99, a decentralized social network where each user will eventually act as a network node. Phase 1 does not implement social features, P2P networking, blockchain, wallet behavior, backend APIs, or authentication flows.

## Core Rule

Any feature may exist only if it has immediate utility in the current phase. Nothing should be created as prophetic code for a future phase.

## Architecture

The app uses React Native with Expo, TypeScript, Expo Router, NativeWind, React Query, Zustand, SQLite, MMKV, React Hook Form, Zod, ESLint, and Prettier.

The source tree follows feature-first Clean Architecture:

```text
src/
  app/
  assets/
  components/
  constants/
  crypto/
  database/
  features/
  hooks/
  network/
  services/
  store/
  types/
  utils/
```

Domain logic must stay isolated from UI and infrastructure. Storage, database, cryptography, and state management communicate through small typed services and interfaces.

## Execution Order

1. Bootstrap Expo, tooling, aliases, environment support, scripts, Git ignore, and source structure.
2. Create a dark-first design system with reusable UI components.
3. Add base navigation: Splash, Onboarding, Create Identity, Home placeholder, Profile placeholder, and Settings.
4. Configure MMKV and a real local storage service.
5. Configure Zustand stores for auth, profile, wallet, settings, network, and contribution.
6. Configure SQLite with an empty schema engine, migration runner, query wrapper, and abstract repository base.
7. Add CryptoService for local cryptographic identity generation and loading.
8. Build Create Identity with real local identity generation and persistence.
9. Harden the project with lint, typecheck, tests, build validation, and refactoring.

## Design System

The interface is mobile-first, premium, minimal, and dark-first. It is inspired by Instagram, X, and Discord without copying them.

Primary palette:

- Black and graphite for surfaces.
- White and light gray for text.
- One electric accent color for interactive states.

Design tokens cover color, typography, spacing, radius, icon sizing, and subtle motion. Accessibility and legibility are required from the start.

Reusable components for Phase 1:

- Button
- Input
- Avatar
- Card
- Modal
- Loading
- Header
- Screen
- Text

## Navigation

Routes are structural only. Home, Profile, and Settings may have polished skeleton UI, but no domain logic. No feed, posts, likes, comments, wallet, P2P, backend, or API behavior is allowed in this phase.

## Local Data

MMKV is introduced before Zustand persistence so stores can depend on the storage abstraction cleanly.

SQLite remains neutral. Phase 1 creates only database infrastructure:

- Migration runner
- Query wrapper
- Abstract repository base

No social tables are created.

## Cryptography

CryptoService is isolated under `src/crypto`. Phase 1 supports:

- Generate an Ed25519 identity key pair.
- Export the public key in a stable text format.
- Persist the private key locally through the storage service.
- Load the stored identity again.

Private-key encryption should be represented by a dedicated boundary so a stronger key derivation strategy can replace the first local implementation without changing callers. No wallet, blockchain, or cryptocurrency behavior is implemented.

## Testing And Quality

Each implementation step must compile, fix warnings and errors, refactor as needed, run available tests, and end in a descriptive commit. The project should remain clean, modular, and ready for the next phase without pretending future functionality exists.
