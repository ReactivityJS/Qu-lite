/**
 * 06 - Deleting and compaction.
 *
 *   node examples/06-delete-compact.mjs
 *
 * A delete is a signed, public DROP LIST: every peer and the blind mirror
 * remove the target, and reconcile never brings it back. Keyed entries get a
 * tombstone. Superseded versions are compacted (your own automatically).
 */
import { twoMembers, until } from './_group.mjs';

const { relay, alice, bob, groupA, groupB } = await twoMembers([['compaction', { delayMs: 200 }]]);
const chat = async (qu, space) => (await qu.query({ space, path: 'chat' })).map((r) => r.value);

const oops = await alice.write(groupA, 'chat', 'sent to the wrong group');
await alice.write(groupA, 'chat', 'hello');
await until(async () => (await chat(bob, groupB)).length === 2);
const before = await relay.mirror.count(groupA.id);

bob.bus.on('qu.record.deleted', ({ id }) => console.log('bob: record deleted', id.slice(0, 12)));
await alice.del(groupA, oops);                                   // a log entry: gone everywhere
await until(async () => (await chat(bob, groupB)).length === 1);
console.log('bob sees:', await chat(bob, groupB));
// The mirror removed the target and stores the drop list instead (it can verify it without a key).
await until(async () => (await relay.mirror.count(groupA.id)) === before);
console.log('mirror envelopes before/after:', before, await relay.mirror.count(groupA.id));

// Keyed entries: the delete is a tombstone that stays the head.
await alice.write(groupA, 'settings', 'dark', { key: 'theme' });
await alice.del(groupA, 'settings', 'theme');
console.log('theme after delete:', await alice.get(groupA, 'settings', 'theme'));

// Superseded versions of a keyed entry: own ones are dropped automatically after `delayMs`,
// `compact(space, { all: true })` (owner/admin) drops everyone's now.
for (const v of [1, 2, 3]) await bob.write(groupB, 'counter', v, { key: 'n' });
await until(async () => (await alice.get(groupA, 'counter', 'n')) === 3);
console.log('alice compacts:', await alice.compact(groupA, { all: true }));

// Local only: forget a space completely on this device (others keep their copies).
console.log('bob forgot', await bob.forget(groupB), 'keys');
