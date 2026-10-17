# Examples

Each file is a complete program: `node examples/<file>` (Node ≥ 22.5, after `npm install`). They import
`@qu/lite` exactly like an app would. `test/examples.test.js` runs them all, so they stay in sync with the
[API reference](../docs/API.md).

| File | Shows |
|---|---|
| [01-records.mjs](01-records.mjs) | one peer: log and keyed entries, `get`, time-window `query`, hooks (transform/veto), listeners, `scrub` |
| [02-sync.mjs](02-sync.mjs) | two peers: `watch`, live sync, offline writes in the outbox, reconcile on reconnect, `resync` |
| [03-mirror-websocket.mjs](03-mirror-websocket.mjs) | `createPeer` for a blind mirror (SQLite, WebSocket server) and clients; reload from disk |
| [04-groups.mjs](04-groups.mjs) | user nodes, `createGroup`, invites by inbox and by link, `reveal`, roles, removal with a new epoch |
| [05-status.mjs](05-status.mjs) | presence, typing, sent/delivered/read, custom signals, clean leave |
| [06-delete-compact.mjs](06-delete-compact.mjs) | deleting log entries and keyed entries, compaction, `forget` |
| [07-text.mjs](07-text.mjs) | collaborative text: concurrent offline edits merge, anchors, snapshots |
| [08-blobs.mjs](08-blobs.mjs) | attachments: offline put, upload progress, fetch on demand, delete |

`_group.mjs` is shared setup for 05-07 (a mirror and two group members in one process).
In the browser, use the same code with `store: ['indexeddb', …]` and `transports: [['relay', { url }]]` -
see [demo/app.js](../demo/app.js) for a complete app.
