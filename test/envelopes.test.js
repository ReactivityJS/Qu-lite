import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQu, envelopes, records, mirror, sync, Space, sealEnvelope, formatHlc, connectInProcess } from '../src/index.js';

async function sealed(space) {
  const identity = (await createQu()).identity;
  return sealEnvelope(space, { path: 'chat', hlc: formatHlc(Date.now()), value: 'x' }, await space.authorFor(identity));
}

test('client and mirror ingest through the same envelope layer; only the keyring differs', async () => {
  const space = await Space.create();
  const { bytes } = await sealed(space);

  const m = await createQu();
  m.use(mirror());
  assert.equal(m.envelopes, envelopes()(m)); // installed once, shared
  assert.equal((await m.envelopes.ingest(bytes)).status, 'unknown-space');

  m.keyring.set(space.id, 0, space.writeKeys().get(0)); // what a verified grant does
  assert.equal((await m.envelopes.ingest(bytes)).status, 'stored');
  assert.equal((await m.envelopes.ingest(bytes)).status, 'duplicate');

  const client = await createQu();
  client.use(records());
  client.join(await Space.open(space.invite));
  assert.equal((await client.envelopes.ingest(bytes)).status, 'stored');
  assert.equal((await client.query({ space: space.id, path: 'chat' }))[0].value, 'x');
});

test('a reader refusing a record (qu.accept) removes its envelope again', async () => {
  const space = await Space.create();
  const { bytes, id } = await sealed(space);
  const client = await createQu();
  client.use(records());
  client.join(await Space.open(space.invite));
  client.bus.on('qu.accept', (_record, ctx) => ctx.stop());
  const outcome = await client.envelopes.ingest(bytes, { from: 'someone' });
  assert.deepEqual([outcome.status, outcome.reason], ['rejected', 'hook']);
  assert.equal(await client.storage.has(`rec/${space.id}/${id}`), false);
  assert.deepEqual(await client.storage.keys(`sx/${space.id}/`), []);
});

test('the mirror allow-list refuses other spaces at the grant and at the record', async () => {
  const allowed = await Space.create();
  const other = await Space.create();
  const m = await createQu();
  m.use(sync({ role: 'mirror' }));
  m.use(mirror({ allow: [allowed.id] }));
  const a = await createQu();
  a.use(records());
  a.use(sync());
  a.join(await Space.open(allowed.invite));
  a.join(await Space.open(other.invite));
  await connectInProcess(a, m).ready;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await m.mirror.spaces(), [allowed.id]);
  m.keyring.set(other.id, 0, other.writeKeys().get(0));
  assert.equal((await m.envelopes.ingest((await sealed(other)).bytes)).reason, 'policy');
});
