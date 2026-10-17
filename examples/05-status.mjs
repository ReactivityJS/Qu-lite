/**
 * 05 - Status: online, typing, sent / delivered / read, and custom signals.
 *
 *   node examples/05-status.mjs
 *
 * Presence and typing are ephemeral SIGNALS: sealed and signed like records,
 * but never stored or synced. Delivered/read are ONE cursor record per member
 * and conversation - no per-message overhead.
 */
import { twoMembers, until } from './_group.mjs';

const { alice, bob, groupA, groupB } = await twoMembers([['status', { interval: 1000 }]]);
const stA = await alice.status(groupA);
const stB = await bob.status(groupB);
const bobAlias = (await bob.members(groupB)).me;
const aliceAlias = (await alice.members(groupA)).me;
const short = ({ sent, delivered, read, members }) => ({ sent, delivered: delivered.map((a) => a.slice(0, 8)), read: read.map((a) => a.slice(0, 8)), members });

await until(() => stA.isOnline(bobAlias));
console.log('alice sees bob online:', stA.isOnline(bobAlias));

alice.bus.on('qu.status.typing', ({ path, typing }) => typing.length && console.log(`typing in ${path}:`, typing.map((a) => a.slice(0, 8))));
await stB.sendTyping('chat');
await until(() => stA.typing('chat').includes(bobAlias));

// sent -> delivered (automatic on arrival) -> read (set by the app)
const message = await alice.write(groupA, 'chat', 'did you read this?');
await until(async () => (await stA.of(message)).sent);
console.log('after sending:  ', short(await stA.of(message)));
await until(async () => (await bob.query({ space: groupB, path: 'chat' })).length === 1);
await stB.markRead('chat');
await until(async () => (await stA.of(message)).read.includes(bobAlias));
console.log('after markRead: ', short(await stA.of(message)));

// Any ephemeral event of your own: `qu.signal(space, type, value)`.
const waved = new Promise((resolve) => bob.bus.on(`qu.signal.${groupB.id}.wave`, ({ author, value }) => resolve({ author: author.slice(0, 8), value })));
await alice.signal(groupA, 'wave', { hi: true });
console.log('bob got a signal:', await waved);

await alice.leave();                       // clean leave: tells the others "offline"
await until(() => stB.isOnline(aliceAlias) === false);
console.log('bob sees alice offline');
