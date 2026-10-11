# Working on Qu Lite

## Commands

```sh
npm ci
npm test               # full suite (node:test), incl. 2 Playwright browser tests
npm run test:unit      # without browser tests
node --test --test-timeout=240000 test/sync.test.js   # one file
npm run demo           # demo + local mirror on :8787
```

Run the full suite **twice** before pushing a non-trivial change - several tests are
timing-based (presence, reconnects) and a single green run can hide flakiness.

## Code conventions

- Plain ESM JavaScript, no build step for the library, no TypeScript; JSDoc for types.
- No runtime dependencies besides `ws` (Node only). Crypto is WebCrypto (`src/crypto.js`).
- Every module starts with a block comment explaining WHAT it does and WHY; keep it
  current when behaviour changes. Comment density like the surrounding code.
- Everything is a plugin `(qu) => api` installed with `qu.use()`; plugins talk over the
  bus (`emit` = sequential with veto, `notify` = parallel side effects, `run` =
  transform chain). Prefer a hook/event over a direct call into another plugin.
- Storage writes of one logical step go into ONE write set (`src/writeset.js`) and are
  committed with one `storage.batch()`; notifications go into `ws.after()`.
- The blind layer (`src/envelopes.js`) must never need a key: anything a mirror has to
  check is decidable from the public header (+ public drop lists).
- Browser-safe barrel (`src/index.js`) must never import Node-only modules
  (`node:sqlite`, `ws`) - those live behind `@qu/lite/node`, `/sqlite`, `/ws-server`.
- Optional features stay optional: nothing in the core may import `text.js`,
  `net/webrtc.js`, `net/topology.js` or the SSE modules.

## Tests

- `node:test` + `node:assert/strict`; shared helpers in `test/helpers.js`
  (`fullClient`, `mirrorNode`, `until`, `values`).
- Wait with `until(check, ms, label)` instead of fixed sleeps.
- New behaviour gets a test in the matching file (or a new `*.test.js`); privacy-relevant
  changes also in `test/privacy.test.js`.

## Commits

- One commit per coherent change; message: short subject (`lite: …` style is fine),
  blank line, bullet points of what changed and why.
- Do not put model names/identifiers into commits, code or docs.

## Background

Read `docs/DECISIONS.md` before changing protocol, storage layout or the privacy model.
The README has one section per milestone (1-12) describing the current behaviour.
