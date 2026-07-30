# Synpeer Real Phase 2/3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Phase 2/3 simulated behavior with real, testable local networking/social integration surfaces.

**Architecture:** Keep the existing feature-first TypeScript structure. Add narrow interfaces where runtime networking cannot be exercised in Jest, so social services call a real transport boundary instead of logging placeholders. UI developer screens should read service state and repositories, never random data.

**Tech Stack:** Expo, React Native, TypeScript, Jest, SQLite abstraction, libp2p boundary classes.

---

### Task 1: Restore TypeScript Verification

**Files:**

- Modify: `tsconfig.json`
- Modify: `src/database/sqliteAdapter.ts`
- Modify: `src/database/__tests__/DatabaseService.test.ts`

- [ ] Add a test assertion that `DatabaseService.query` delegates to `getAllAsync`.
- [ ] Run the focused test and typecheck to observe the failure.
- [ ] Add `getAllAsync` to the Expo SQLite adapter.
- [ ] Silence the TypeScript 6 `baseUrl` deprecation with `ignoreDeprecations`.
- [ ] Run `npm.cmd run typecheck` and focused tests.

### Task 2: Add Real Social Transport Boundary

**Files:**

- Create: `src/services/social/SocialTransport.ts`
- Modify: `src/services/social/PostService.ts`
- Modify: `src/services/social/FeedService.ts`
- Modify: `src/services/social/FollowService.ts`
- Modify: `src/services/social/CommentService.ts`
- Modify: `src/services/social/ReactionService.ts`
- Modify: `src/services/social/SyncService.ts`
- Test: `src/services/social/__tests__/SocialTransport.test.ts`

- [ ] Write failing tests proving services publish packets through a transport instead of logging.
- [ ] Implement a small `SocialTransport` interface with network-backed and in-memory implementations.
- [ ] Inject the transport into social services with a network-backed default.
- [ ] Make sync request methods call transport request APIs and return received counts.
- [ ] Run social service tests and typecheck.

### Task 3: Replace Random Developer Screens

**Files:**

- Modify: `src/features/network/NetworkMonitorScreen.tsx`
- Modify: `src/features/social/SocialInspectorScreen.tsx`

- [ ] Add tests or extract pure snapshot helpers where practical.
- [ ] Read live `NetworkService` state for peer id, peers, uptime, reconnects, latency, and errors.
- [ ] Read repository/service stats for social inspector rather than generating random numbers.
- [ ] Remove simulated intervals and random data.

### Task 4: Replace Main Placeholders With Real Social Surfaces

**Files:**

- Modify: `src/app/home.tsx`
- Modify: `src/app/profile.tsx`
- Create/modify: `src/features/social` screens as needed.

- [ ] Add minimal feed/composer screen backed by `PostService`.
- [ ] Add minimal profile screen backed by profile/follow repository data.
- [ ] Keep offline-first behavior: local writes succeed without peers.
- [ ] Preserve navigation to profile/settings.

### Task 5: Final Verification

**Files:**

- All touched files.

- [ ] Run `npm.cmd run lint`.
- [ ] Run `npm.cmd run typecheck`.
- [ ] Run `npm.cmd test -- --runInBand`.
- [ ] Review remaining `TODO`, placeholder, random, and console-only sync references.
