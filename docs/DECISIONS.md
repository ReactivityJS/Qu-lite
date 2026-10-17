# Qu Lite – requirements and design decisions

Why Qu Lite looks the way it does. The README describes WHAT each part does; this file
keeps the reasons, the rejected alternatives and the known limits, so later changes
don't undo a deliberate choice by accident.

## Why a new, small core

- An older Qu version burned gigabytes of data volume by syncing (replaying history).
  Low data volume is a first-class requirement, not an optimisation.
- Alternatives considered: GunDB, TopGun, GenosDB. Rejected because of last-write-wins
  only data models, proprietary or Nostr/P2P-specific parts, no blind (key-less) relay
  that can still verify records, and/or no group encryption with key epochs.
- A clean start was preferred over carrying legacy: Qu Lite shares no code with the
  Yjs-based QuV5 packages. Older parts were only reused where good and compatible.

## Requirements (as stated by the project owner)

1. **Small, stable, modular**: event network as the basis (local and remote listeners,
   hooks), mount & adapter principle like unstorage, scalable to medium size.
2. **Offline-first**: no server-assigned sequence numbers - every client orders its own
   writes (HLC). Pending syncs survive reloads and network drops.
3. **Lean sync, low volume**: cost proportional to the difference, never to history;
   reliable resync and repair, triggerable; time-window queries.
4. **Encryption**: atomic records encrypted end to end; group encryption.
5. **Records are stored encrypted, everywhere**: decrypting would void the signature,
   so every peer - member or not, relay or mirror - stores the sealed envelope and can
   verify it without being able to read it. (This is how Qu always worked.)
6. **Privacy / metadata**: spaces have their own ids; the author is always a pseudonym
   (per-space alias, "fake identity"); members are referenced by real or fake identity;
   titles, fields and member lists of private groups are private. A user node is a
   space reachable by the user's public key (idea from GunDB) with public and private
   fields.
7. **Relay/mirror on the same peer base as a client** - no duplicated code; transports
   are plugins (WebSocket first, HTTPS+SSE and WebRTC as alternatives).
8. **Status**: online, typing, sent, delivered, read - without per-message overhead.
9. **Inbox per user** for invitations and messages from non-members.

## Key decisions

| Topic | Decision | Why |
|---|---|---|
| Ordering | HLC per client (`src/hlc.js`), remote clocks bounded by `maxDriftMs` | offline-first, no central sequencer |
| Envelope | v2: 192-byte public header (sid, shard tag, epoch, coarse ts in minutes, author alias) + two signatures (author, epoch write key) + AES-GCM ciphertext; id = SHA-256 of the envelope | any peer verifies membership and authorship without a key; content-addressed dedupe |
| Shards | HMAC tag of the path's first segment | partial sync without revealing paths |
| Identity | per-space alias derived from the identity (HKDF); user nodes sign with the identity | unlinkable authors across spaces |
| Groups | secret + owner alias; epochs (write key + AES key) rotate on removal; epoch n signed by owner/admin; keys delivered as anonymous sealed boxes padded to 8 | removed members can't write the next epoch; mirror verifies the grant chain |
| Sync | Negentropy range-based set reconciliation over the public sync index `sx/<sid>/<shard>/<ts>-<id>` | ~2 KB to reconcile 10,000 records + 1 change (vs. MBs for a replay) |
| Durability | outbox `sync/out/` (until a mirror acks), `sync/pending/` reconciles, resumed on connect | survive reloads and drops |
| Atomicity | one write set per envelope (record, sync index, pointer indexes, outbox) in one `storage.batch()` | no half-written state after a crash |
| LWW | keyed entries by (hlc, author); superseded versions kept until compaction; per-space commit lock only around the head decision | deterministic, race-free |
| Deletion | public, signed drop lists (`<segment>/_gc`) applied blind by every peer; gone markers keep the sync-index entry; 90-day protocol horizon | deletions reach the key-less mirror and never come back via reconcile |
| Status | ephemeral signals (never stored) for presence/typing; ONE receipt cursor record per member and conversation | no per-message receipts |
| Mirror | a policy on the shared peer base: accept/persist grants, watch spaces, quotas, rate limits; never initiates towards clients, never sends them subs | no sid leaks, no per-space cost per connect |
| Padding | private inners padded to quarter steps (min 128 B, ≤ +25 %) | content size only roughly visible; owner chose the volume-friendly default |
| Isolation | opt-in one connection per space (`relayTransport({isolate: true})`) | relay can't link spaces to a device via the protocol |
| Decoy subscriptions | not built | a relay recognises them at once (no grants, no data) |
| Text | optional RGA CRDT plugin, per-member mergeable snapshots; chars kept as runs (split/extended), same per-char RGA order and wire format | collaborative notes in small groups; not part of the core; lean without a tree or a second format |
| Attachments | optional `blobs` plugin: manifest + 64 KiB chunks as ordinary records, content-addressed and hash-verified, one shard per blob; wake lock + unload warning while transfers run | everything (encryption, mirror, quotas, deletion, sync) reused; no binary side channel for the blind mirror; fetch on demand |
| Stale devices | remember the last complete reconcile per scope; past the horizon, old records the peer lacks are retired locally, not pushed | no resurrection of deleted records without a protocol change or a mirror-side guess |

## Known limits

- IP address and timing still link connections (use a proxy/Tor in front).
- A device offline longer than the 90-day drop-list horizon retires its records older than the
  horizon that the network lacks (`sync.stale`) - they may have been deleted. If a mirror lost
  its data instead, such a device does not refill those old records (`sync({stale: 'push'})`
  does); devices synced within the horizon still do.
- Group members are trusted not to vandalise shared data (they can delete or, in a
  text document, pre-empt another site's char ids).
- Text CRDT keeps the whole document in memory as runs: cost grows with the number of edits,
  not of chars; heavily fragmented documents (many scattered single-char edits) grow
  accordingly until compacted.
- Size per mirror envelope defaults to 256 KiB (`maxEnvelopeBytes`).
- Attachments travel as base64 inside records (+33 %, plus padding) and are assembled in
  memory (`maxBytes`, 64 MiB). The mirror can tell which records form one attachment (one
  shard) and roughly its size. Wake Lock and `beforeunload` only help while the page is
  open; a browser that kills a background tab still stops the transfer (it resumes later).

## Milestones (all done)

1 kernel, mounts, spaces · 2 Negentropy sync, partial sync, repair, outbox · 3
persistence, WebSocket, mirror · 4 privacy model, one peer base, Docker relay + demo ·
5 members, epochs, inbox · 6 status · 7 WebRTC · 8 HTTPS+SSE fallback · 9 atomic writes
· 10 deletion and compaction · 11 mirror hardening and metadata · 12 collaborative text
(optional) · 13 stale devices (offline past the horizon) · 14 attachments (optional) · 15 relay,
client page and demo on one port, behind a TLS reverse proxy.
