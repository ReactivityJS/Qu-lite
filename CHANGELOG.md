# Changelog

All notable changes to `@qu/lite`. The format follows [Keep a Changelog](https://keepachangelog.com/),
versions follow [Semantic Versioning](https://semver.org/) - before 1.0, a minor version may change the API.

## [Unreleased]

## [0.1.0] - 2026-10-17

First release as a standalone repository (previously `packages/lite` in
[QuV5](https://github.com/ReactivityJS/QuV5); history preserved).

### Added

- Kernel: event bus with hooks (`emit`/`notify`/`run`/`collect`), unstorage-style mounts, registry, `createQu`/`createPeer`.
- Spaces (groups, user nodes, inboxes) with opaque ids, per-space author aliases and key epochs.
- Envelope v2: records sealed and signed over the ciphertext, verifiable by any peer or mirror without a key; padding.
- Records: log and last-write-wins entries, time-window queries, hooks, scrub/repair, atomic write sets.
- Sync: Negentropy set reconciliation (cost ∝ difference), partial sync by path/time window, durable outbox,
  resumable reconciles, `ackFrom: 'mirror'`.
- Storage drivers: memory, IndexedDB, SQLite (`node:sqlite`).
- Transports: in-process, WebSocket (with reconnect), HTTPS + SSE fallback (`relayTransport`), WebRTC with
  sealed signaling, topology (`star`/`mesh`/`auto`), one connection per space (`isolate`).
- Members: owner/admin/member roles, admin-signed epoch chain, invites by link or inbox, verifiable reveal,
  removal with key rotation; per-user inboxes; user nodes with public and private fields.
- Status: presence, typing, sent/delivered/read without per-message overhead; ephemeral signals.
- Deletion and compaction: signed drop lists honoured by every peer and the blind mirror, tombstones,
  auto-compaction, 90-day horizon.
- Mirror: blind relay on the same peer base, quotas, size limits, rate limits, `qu-lite-mirror` CLI, Docker image.
- Optional collaborative text (RGA CRDT) with anchors and snapshots.
- Documentation: API reference (`docs/API.md`), runnable examples (`examples/`, executed by the test suite),
  design decisions (`docs/DECISIONS.md`).

[Unreleased]: https://github.com/ReactivityJS/Qu-lite/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ReactivityJS/Qu-lite/releases/tag/v0.1.0
