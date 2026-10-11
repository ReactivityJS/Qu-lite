import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextCrdt, text, compaction, createQu, sync, mirror } from '../src/index.js';
import { fullClient, connectInProcess, until } from './helpers.js';

/** Deterministic pseudo-random numbers, so a failing fuzz run can be replayed. */
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test('CRDT: replicas that see the same ops in any order end with the same text', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const random = rng(seed);
    const sites = ['a.1', 'b.2', 'c.3'];
    const replicas = sites.map(() => new TextCrdt());
    const log = sites.map(() => []);
    for (let step = 0; step < 60; step++) {
      const r = Math.floor(random() * 3);
      const doc = replicas[r];
      const length = doc.value().length;
      if (length && random() < 0.3) log[r].push(...doc.delete(Math.floor(random() * length), 1 + Math.floor(random() * 3)));
      else log[r].push(doc.insert(Math.floor(random() * (length + 1)), 'xyz'.slice(0, 1 + Math.floor(random() * 3)) + r, sites[r]));
      // sometimes a replica catches up on someone else's ops (partial, out of order)
      if (random() < 0.3) {
        const from = Math.floor(random() * 3);
        for (const op of [...log[from]].sort(() => random() - 0.5)) replicas[r].apply(op);
      }
    }
    const everything = log.flat();
    for (const doc of replicas) for (const op of [...everything].sort(() => random() - 0.5)) doc.apply(op);
    const [first, ...rest] = replicas.map((doc) => doc.value());
    for (const other of rest) assert.equal(other, first, `seed ${seed}`);
    assert.ok(first.length > 0, `seed ${seed}: empty text proves nothing`);
  }
});

test('CRDT: a snapshot (runs, without deleted text) rebuilds the same text and merges with later ops', () => {
  const a = new TextCrdt();
  a.insert(0, 'Hallo Welt', 'a.1');
  a.delete(0, 6);
  a.insert(0, 'Schöne ', 'a.1');
  const runs = a.runs();
  assert.ok(!JSON.stringify(runs).includes('Hallo'), 'deleted text is not kept');
  const b = new TextCrdt();
  for (const op of TextCrdt.opsOfRuns(runs)) b.apply(op);
  assert.equal(b.value(), 'Schöne Welt');
  const later = a.insert(a.value().length, '!', 'a.1');
  b.apply(later);
  assert.equal(b.value(), a.value());
});

const fast = { batchMs: 20, snapshotEvery: 0 };

async function member(m) {
  const qu = await fullClient();
  qu.use(compaction({ delayMs: 20, expireEveryMs: 0 }));
  qu.use(text(fast));
  qu.link = connectInProcess(qu, m);
  await qu.link.ready;
  return qu;
}

async function setup(n) {
  const m = await createQu();
  m.use(sync({ role: 'mirror', timeoutMs: 5000, retryMs: 0 }));
  m.use(mirror({ expireEveryMs: 0 }));
  await m.mirror.ready;
  const peers = [];
  for (let i = 0; i < n; i++) peers.push(await member(m));
  const spaces = [await peers[0].createGroup()];
  for (const p of peers.slice(1)) spaces.push(await p.acceptInvite(await (await peers[0].members(spaces[0])).invite()));
  for (const [i, p] of peers.entries()) await until(async () => (await p.members(spaces[i])).list().length === n, 5000, 'members');
  return { m, peers, spaces };
}

test('two members type into one note - live, and concurrently while one is offline - and converge', async () => {
  const { m, peers: [alice, bob], spaces: [sa, sb] } = await setup(2);
  const da = await alice.text(sa, 'notes/main');
  const db = await bob.text(sb, 'notes/main');
  da.insert(0, 'Hallo');
  await until(() => db.value() === 'Hallo', 5000, 'bob sees Hallo');
  db.insert(5, ' Welt');
  await until(() => da.value() === 'Hallo Welt', 5000, 'alice sees Welt');

  await bob.link.disconnect();
  da.insert(0, '>> ');
  db.delete(0, 5); // "Hallo" gone at bob
  db.insert(db.value().length, '!');
  await da.flush();
  await db.flush();
  bob.link = connectInProcess(bob, m);
  await bob.link.ready;
  await bob.resync({ space: sb });
  await until(() => da.value() === db.value() && da.value() === '>>  Welt!', 5000, `converged: "${da.value()}" / "${db.value()}"`);
});

test('typing is batched: many keystrokes, few records', async () => {
  const { peers: [alice], spaces: [sa] } = await setup(1);
  const doc = await alice.text(sa, 'notes/batch');
  for (const ch of 'Schnell getippt, wenige Records.') doc.insert(doc.value().length, ch);
  await doc.flush();
  const batches = await alice.query({ space: sa, path: 'notes/batch' });
  assert.equal(batches.length, 1);
});

test('anchors keep a caret in place across remote edits', async () => {
  const { peers: [alice, bob], spaces: [sa, sb] } = await setup(2);
  const da = await alice.text(sa, 'notes/caret');
  const db = await bob.text(sb, 'notes/caret');
  da.insert(0, 'abcdef');
  await until(() => db.value() === 'abcdef', 5000, 'synced');
  const caret = da.anchor(3); // before "d"
  db.insert(0, 'XYZ');
  await until(() => da.value() === 'XYZabcdef', 5000, 'remote insert');
  assert.equal(da.indexOf(caret), 6);
});

test('compaction: snapshots per member, own batches dropped everywhere - a newcomer loads the same text', async () => {
  const { m, peers: [alice, bob], spaces: [sa, sb] } = await setup(2);
  const da = await alice.text(sa, 'notes/long');
  const db = await bob.text(sb, 'notes/long');
  for (let i = 0; i < 10; i++) {
    da.insert(da.value().length, `a${i} `);
    await da.flush();
    db.insert(0, `b${i} `);
    await db.flush();
  }
  await until(() => da.value() === db.value() && da.value().length > 0, 5000, 'converged');
  const expected = da.value();
  // both compact at the same time - neither may lose the other's text
  await Promise.all([da.compact(), db.compact()]);
  await until(async () => (await m.storage.keys(`gone/${sa.id}/`)).length >= 20, 5000, 'own batches dropped at the mirror');
  assert.equal(da.value(), expected);

  const carol = await member(m);
  const sc = await carol.acceptInvite(await (await alice.members(sa)).invite());
  await carol.resync({ space: sc });
  const dc = await carol.text(sc, 'notes/long');
  assert.equal(dc.value(), expected);
  dc.insert(0, 'C ');
  await until(() => da.value() === `C ${expected}` && db.value() === da.value(), 5000, 'carol edits');
});

test('nobody can overwrite another member\'s snapshot, and batch ops must carry their author\'s site', async () => {
  const { peers: [alice, bob], spaces: [sa, sb] } = await setup(2);
  const da = await alice.text(sa, 'notes/safe');
  const db = await bob.text(sb, 'notes/safe');
  da.insert(0, 'mine');
  await da.compact();
  await until(() => db.value() === 'mine', 5000, 'bob synced');
  const aliceAlias = (await alice.members(sa)).me;

  const refused = new Promise((resolve) => alice.bus.on('qu.record.rejected', (e) => e.reason === 'not your snapshot' && resolve()));
  await bob.write(sb, 'notes/safe/_snap', { v: 1, runs: [] }, { key: aliceAlias });
  await refused;
  // a batch claiming alice's site is ignored
  await bob.write(sb, 'notes/safe', { v: 1, site: da.site, ops: [['i', 999, null, null, 'FORGED']] });
  db.insert(0, '>');
  await until(() => da.value() === '>mine', 5000, 'bob\'s real edit arrives');
  assert.ok(!da.value().includes('FORGED'));
});
