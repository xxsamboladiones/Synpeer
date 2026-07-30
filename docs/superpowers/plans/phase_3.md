# Synpeer — Phase 3: Decentralized Social Layer

## Goal

Build the first fully functional decentralized social network on top of the P2P layer.

At the end of this phase, users should be able to create identities, publish posts, follow other users, receive synchronized content from peers, and interact with posts without any centralized server.

No blockchain.

No cryptocurrency.

No backend.

Everything must travel through the existing P2P network.

---

# Objectives

Implement the complete decentralized social layer.

The application should behave like a minimal social network whose data is entirely distributed among peers.

---

# Architecture

```
src/

features/
    identity/
    posts/
    feed/
    profile/
    comments/
    reactions/
    follows/

protocols/
    posts/
    feed/
    profile/
    comments/
    follows/

repositories/
    PostRepository.ts
    ProfileRepository.ts
    CommentRepository.ts

models/
    Post.ts
    Profile.ts
    Comment.ts
    Follow.ts
    Reaction.ts
```

---

# Task 1 — Domain Models

Create immutable domain models.

Models

- Identity
- Profile
- Post
- Comment
- Follow
- Reaction
- TimelineCursor

Every model must contain:

- id
- author
- createdAt
- updatedAt
- signature
- version

Validation

- Unit tests
- Serialization
- Signature compatibility

Commit

```
feat: add social domain models
```

---

# Task 2 — Local Repositories

Create repositories using SQLite.

Repositories

PostRepository

ProfileRepository

CommentRepository

FollowRepository

ReactionRepository

Responsibilities

CRUD

Indexes

Pagination

Version tracking

Soft delete support

Commit

```
feat: add local social repositories
```

---

# Task 3 — Social Protocol

Create new protocols.

```
protocols/

posts/

comments/

reactions/

follows/

feed/
```

Capabilities

Publish

Receive

Update

Delete (soft delete)

Reject duplicates

Reject invalid signatures

Commit

```
feat: implement social synchronization protocols
```

---

# Task 4 — Create Posts

Create complete post flow.

Supported

Text posts only.

Maximum length configurable.

Fields

Post ID

Author

Timestamp

Text

Signature

Hash

Automatic local persistence.

Automatic network broadcast.

Commit

```
feat: add decentralized post publishing
```

---

# Task 5 — Feed

Implement chronological feed.

Requirements

Merge local posts.

Merge remote posts.

Sort by timestamp.

Ignore duplicates.

Lazy pagination.

Offline support.

No recommendation algorithm.

No ranking.

Commit

```
feat: implement decentralized feed
```

---

# Task 6 — Profile

Create profile feature.

Capabilities

View profile.

Edit profile.

Avatar.

Bio.

Post counter.

Follower count.

Following count.

Automatic synchronization.

Commit

```
feat: implement decentralized profiles
```

---

# Task 7 — Follow System

Implement follow graph.

Capabilities

Follow user.

Unfollow.

Sync relationships.

Prevent duplicate follows.

Commit

```
feat: add follow system
```

---

# Task 8 — Comments

Implement comments.

Requirements

Signed comments.

Parent relationship.

Synchronization.

Chronological ordering.

Soft delete.

Commit

```
feat: implement decentralized comments
```

---

# Task 9 — Reactions

Implement reactions.

Supported

Like only.

Every reaction must be signed.

Duplicate likes prohibited.

Synchronization required.

Commit

```
feat: implement decentralized reactions
```

---

# Task 10 — Conflict Resolution

Implement deterministic conflict resolution.

Rules

Newest version wins.

Duplicate packets ignored.

Invalid signatures rejected.

Clock drift tolerance.

Version reconciliation.

Commit

```
feat: implement conflict resolution
```

---

# Task 11 — Background Synchronization

Implement automatic synchronization.

Triggers

Peer connected.

App foreground.

Manual refresh.

Periodic sync.

Never block UI.

Commit

```
feat: add automatic social synchronization
```

---

# Task 12 — Offline First

Guarantee offline operation.

Capabilities

Create posts offline.

Queue synchronization.

Merge changes.

Conflict detection.

Delayed propagation.

Commit

```
feat: implement offline-first workflow
```

---

# Task 13 — UI Integration

Replace placeholders.

Implement

Feed

Profile

Post composer

Comments

Follow button

Loading states

Empty states

Skeletons

Error states

Commit

```
feat: integrate decentralized social ui
```

---

# Task 14 — Developer Tools

Create Social Inspector.

Display

Total posts

Profiles

Comments

Reactions

Pending sync queue

Known peers

Replication status

Database statistics

Last synchronization

Commit

```
feat: add social inspector
```

---

# Task 15 — Hardening

Run

- lint
- typecheck
- tests

Review

Memory leaks

Packet validation

Repository consistency

Duplicate detection

Offline workflow

Synchronization

Large feed performance

Commit

```
chore: harden phase 3 social layer
```

---

# Deliverables

At the end of Phase 3 the application must provide:

- Fully decentralized user profiles.
- Decentralized post publishing.
- Chronological distributed feed.
- Follow system.
- Signed comments.
- Signed likes.
- Background synchronization.
- Offline-first behavior.
- Conflict resolution.
- No backend.
- No blockchain.
- No centralized storage.

The application should already be usable as a real decentralized social network, even without any cryptocurrency.

---

# Success Criteria

✔ Users can create posts.

✔ Posts propagate through peers.

✔ Users can follow each other.

✔ Comments synchronize automatically.

✔ Likes synchronize automatically.

✔ Everything works offline and synchronizes later.

✔ All social objects are cryptographically signed.

✔ Zero centralized servers.

✔ Zero blockchain dependencies.

Phase 3 is complete when Synpeer functions as a true peer-to-peer social network.
