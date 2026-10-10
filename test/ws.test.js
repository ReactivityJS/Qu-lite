import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQu, records, sync, Space, connectWs } from '../src/index.js';
import { sqliteDriver } from '../src/drivers/sqlite.js';
import { startMirror } from '../bin/mirror.mjs';

const dir = mkdtempSync(join(tmpdir(), 'qu-lite-ws-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('until: condition not met in time');
    await settle(20);
  }
}
const values = async (qu, space, path) => (await qu.query({ space, path })).map((r) => r.value);

async function client({ root, identity } = {}) {
  const qu = await createQu({ root, identity });
  qu.use(records());
  qu.use(sync({ releaseMs: 0, timeoutMs: 5000, ackFrom: 'mirror' }));
  return qu;
}

test('over real WebSockets: live sync, mirror restart, auto-reconnect and a client reload from SQLite', async () => {
  const db = join(dir, 'mirror.sqlite');
  let mirror = await startMirror({ port: 0, db, log: () => {} });
  const url = `ws://127.0.0.1:${mirror.port}`;

  const clientDb = join(dir, 'client-a.sqlite');
  let rootA = sqliteDriver({ path: clientDb });
  let a = await client({ root: rootA });
  const identityA = a.identity;
  const secret = (await Space.create()).secret;
  let sa = a.join(await Space.open(secret));
  const b = await client();
  const sb = b.join(await Space.open(secret));
  await b.watch({ space: sb });

  let connA = connectWs(a, url, { minDelayMs: 50 });
  const connB = connectWs(b, url, { minDelayMs: 50 });
  await until(() => connA.connected && connB.connected);

  await a.write(sa, 'chat', 'hello over ws');
  await until(async () => (await values(b, sb, 'chat')).length === 1);
  await until(async () => (await a.syncStatus()).outbox === 0);

  // Mirror goes down; A keeps writing offline; mirror comes back on the same port + db.
  await mirror.close();
  await until(() => !connA.connected && !connB.connected);
  await a.write(sa, 'chat', 'written while the mirror was down');
  assert.equal((await a.syncStatus()).outbox, 1);
  mirror = await startMirror({ port: Number(new URL(url).port), db, log: () => {} });
  await until(() => connA.connected && connB.connected);
  await until(async () => (await values(b, sb, 'chat')).length === 2);
  await until(async () => (await a.syncStatus()).outbox === 0);

  // A "reloads": new process state over the same SQLite file, unsent write pending.
  connA.close();
  await until(() => !connA.connected);
  await a.write(sa, 'chat', 'written right before the reload');
  rootA.close();
  rootA = sqliteDriver({ path: clientDb });
  a = await client({ root: rootA, identity: identityA });
  sa = a.join(await Space.open(secret));
  assert.equal((await a.syncStatus()).outbox, 1);
  connA = connectWs(a, url, { minDelayMs: 50 });
  await until(async () => (await values(b, sb, 'chat')).length === 3);
  await until(async () => (await a.syncStatus()).outbox === 0);
  assert.deepEqual((await values(a, sa, 'chat')).length, 3);

  connA.close();
  connB.close();
  rootA.close();
  await mirror.close();
});
