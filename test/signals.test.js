import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, sealEnvelope, formatHlc, Space } from '../src/index.js';
import { fullClient, mirrorNode, connectInProcess, until, settle } from './helpers.js';

async function pair() {
  const m = await mirrorNode();
  const a = await fullClient();
  const b = await fullClient();
  await connectInProcess(a, m).ready;
  await connectInProcess(b, m).ready;
  const sa = await a.createGroup();
  const sb = await b.acceptInvite(await (await a.members(sa)).invite());
  await until(async () => (await a.members(sa)).list().length === 2 && (await b.members(sb)).list().length === 2);
  return { m, a, b, sa, sb };
}

test('a signal reaches the other member through the mirror, which stores nothing and reads nothing', async () => {
  const { m, a, b, sa, sb } = await pair();
  const frames = [];
  m.bus.on('net.out.**', (payload, ctx) => frames.push(Buffer.from(encodeFrame(ctx.topic.split('.')[3], payload))));
  const before = (await m.storage.keys('rec/')).length;
  const got = [];
  b.bus.on(`qu.signal.${sb.id}.wave`, (s) => got.push(s));
  await a.signal(sa, 'wave', { hello: 'Bob' });
  await until(() => got.length === 1);
  assert.equal(got[0].value.hello, 'Bob');
  assert.equal(got[0].author, (await a.members(sa)).me);
  assert.equal((await m.storage.keys('rec/')).length, before);
  assert.equal(Buffer.concat(frames).includes(Buffer.from('Bob')), false);
});

test('replayed, stale and foreign signals are dropped', async () => {
  const { a, b, sa, sb } = await pair();
  const got = [];
  const dropped = [];
  b.bus.on(`qu.signal.${sb.id}.*`, (s) => got.push(s));
  b.bus.on('qu.signal.dropped', (d) => dropped.push(d.reason));

  // replay: the same bytes twice
  let captured = null;
  a.bus.on('net.out.*.sig', ({ bytes }) => (captured = bytes));
  await a.signal(sa, 'ping', 1);
  await until(() => got.length === 1 && captured);
  await b.bus.emit(`net.in.${a.peerId}.sig`, { bytes: captured });
  await settle(50);
  assert.equal(got.length, 1);

  // stale: a correctly signed signal from ten minutes ago
  const signer = await sa.authorFor(a.identity);
  const old = await sealEnvelope(sa, { path: '_sig/ping', hlc: formatHlc(Date.now() - 10 * 60_000), value: 2 }, signer);
  await b.bus.emit(`net.in.${a.peerId}.sig`, { bytes: old.bytes });
  // foreign: signed for another space
  const other = await Space.create(a.identity);
  const foreign = await sealEnvelope(other, { path: '_sig/ping', hlc: formatHlc(Date.now()), value: 3 }, await other.authorFor(a.identity));
  await b.bus.emit(`net.in.${a.peerId}.sig`, { bytes: foreign.bytes });
  await settle(50);
  assert.equal(got.length, 1);
  assert.ok(dropped.includes('stale') && dropped.includes('unverified'));
});
