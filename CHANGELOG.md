# Changelog

All notable changes to `@qu/lite`. The format follows [Keep a Changelog](https://keepachangelog.com/),
versions follow [Semantic Versioning](https://semver.org/) - before 1.0, a minor version may change the API.

## [Unreleased]

### Added

- Stale-device check: a device whose last complete sync of a space is older than the 90-day drop-list horizon no
  longer pushes old records the network lacks (they may have been deleted meanwhile) - it retires them locally.
  `qu.staleSpaces()`, `qu.lastSync()`, event `sync.stale`, option `sync({ stale: 'retire' | 'push' })`,
  `qu.envelopes.retire()`.
- Attachments: `blobs()` plugin - chunked, encrypted, content-addressed blobs as ordinary records, fetched on demand,
  upload/download progress (`qu.blob.progress`, `qu.blob.done`), uploads tracked across reloads, screen wake lock and
  unload warning while transfers run. Example `examples/08-blobs.mjs`.
- One port for everything: the relay serves a client start page (`/`, connection check and connect snippet), the demo
  (`/demo.html`), the library as one browser module (`/dist/qu-lite.js`), `/healthz` and `/info` next to `/ws` and
  `/sse`. WebSocket heartbeat (`pingMs`, 25 s) for reverse proxies; `relayTransport` keeps a URL path prefix.
  Deployment guide with Caddy and nginx: `docs/DEPLOY.md`.

### Changed

- The web files moved from `demo/` to `web/` (`index.html` = start page, `demo.html` = demo); `npm run build:web`
  replaces `npm run demo:build`. The Docker healthcheck uses `/healthz`.

- Text CRDT keeps chars as runs (split where an edit lands, extended while typing): 100k typed chars in ~10 ms
  instead of ~12 s, snapshot load instantly instead of ~1.7 s. Ops and snapshot format are unchanged.

### Fixed

- `doc.set()` and the end anchor now count code points like every other text position (emoji were split).
- Demo: the shared note was bound to the private-note input (two elements with `id="note"`).

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
