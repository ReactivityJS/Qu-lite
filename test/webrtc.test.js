import { test } from 'node:test';
import assert from 'node:assert/strict';
import { status, rtc, encodeFrame } from '../src/index.js';
import { fullClient, mirrorNode, connectInProcess, until, settle, values } from './helpers.js';
import { FakeRTCPeerConnection } from './fake-rtc.js';

async function setup(names, rtcOptions = {}) {
  const m = await mirrorNode();
  const peers = {};
  for (const n of names) {
    const qu = await fullClient();
    qu.use(status({ interval: 100, receiptThrottleMs: 20 }));
    qu.use(rtc({ RTCPeerConnectionImpl: FakeRTCPeerConnection, ...rtcOptions[n], ...rtcOptions.all }));
    if (process.env.DBG) qu.bus.on('net.rtc.**', (p, ctx) => console.log(n, ctx.topic, JSON.stringify(p).slice(0, 100)));
    qu.link = connectInProcess(qu, m);
    await qu.link.ready;
    peers[n] = qu;
  }
  const [first, ...rest] = names;
  const spaces = { [first]: await peers[first].createGroup() };
  for (const n of rest) spaces[n] = await peers[n].acceptInvite(await (await peers[first].members(spaces[first])).invite());
  for (const n of names) await until(async () => (await peers[n].members(spaces[n])).list().length === names.length);
  for (const n of names) await peers[n].rtc.track(spaces[n]);
  return { m, peers, spaces };
}

const directPeers = (qu) => {
  const set = new Set();
  qu.bus.on('net.peer.up', ({ peer, via }) => via === 'webrtc' && set.add(peer));
  qu.bus.on('net.peer.down', ({ peer }) => set.delete(peer));
  return set;
};

test('members open direct links, which keep working when the relay is gone', async () => {
  const m = await mirrorNode();
  const watch = {};
  const { peers, spaces } = await (async () => {
    const r = await setup(['alice', 'bob']);
    return r;
  })();
  for (const n of ['alice', 'bob']) watch[n] = (await peers[n].rtc.track(spaces[n])).links;
  await until(() => watch.alice().some((l) => l.connected) && watch.bob().some((l) => l.connected), 5000, 'direct link up');

  await peers.alice.link.disconnect();
  await peers.bob.link.disconnect(); // the relay is unreachable for both
  await peers.alice.write(spaces.alice, 'chat', 'direkt');
  await until(async () => (await values(peers.bob, spaces.bob, 'chat')).includes('direkt'), 5000, 'delivered peer-to-peer');
  void m;
});

test('signaling is sealed: the relay sees neither SDP nor ICE, and other members cannot open it', async () => {
  const { m, peers, spaces } = await setup(['alice', 'bob', 'carol'], { carol: { mode: 'relay-only' } });
  const frames = [];
  m.bus.on('net.out.**', (payload, ctx) => frames.push(Buffer.from(encodeFrame(ctx.topic.split('.')[3], payload))));
  const tracker = await peers.alice.rtc.track(spaces.alice);
  await until(() => tracker.links().some((l) => l.connected), 5000);
  await tracker.closeAll('test');
  await tracker.reconcile();
  await until(() => tracker.links().some((l) => l.connected), 5000);
  const wire = Buffer.concat(frames);
  for (const needle of ['fake-offer', 'fake-answer', 'candidate:fake']) assert.equal(wire.includes(Buffer.from(needle)), false, needle);
  assert.deepEqual((await peers.carol.rtc.track(spaces.carol)).links(), []); // relay-only never connects
});

test('relay-only closes every direct link; auto falls back to a fanout in larger groups', async () => {
  const names = ['alice', 'bob', 'carol', 'dave'];
  const { peers, spaces } = await setup(names, { all: { maxMesh: 3, fanout: 1 } });
  const trackers = await Promise.all(names.map((n) => peers[n].rtc.track(spaces[n])));
  await until(() => trackers.some((t) => t.links().some((l) => l.connected)), 5000, 'some direct link');
  await settle(300);
  // each peer offers to at most `fanout` others: at most 4 links instead of the full mesh's 6
  const pairs = new Set();
  trackers.forEach((t, i) => t.links().forEach((l) => pairs.add([peers[names[i]].peerId, l.alias].sort().join())));
  const connected = trackers.reduce((n, t) => n + t.links().filter((l) => l.connected).length, 0) / 2;
  assert.ok(connected <= 4, `fanout respected (${connected} links)`);

  const alice = trackers[0];
  await peers.alice.rtc.setMode('relay-only');
  assert.deepEqual(alice.links(), []);
  await peers.alice.write(spaces.alice, 'chat', 'via relay');
  await until(async () => (await values(peers.bob, spaces.bob, 'chat')).includes('via relay'));
});
