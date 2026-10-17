/**
 * 04 - Groups: user nodes, invites by inbox, roles, removal with a new epoch.
 *
 *   node examples/04-groups.mjs
 *
 * Members are known by a per-space ALIAS, never by their identity. The owner
 * signs the admin list, admins sign key epochs; removing a member rotates the
 * key for everyone else. An invite can travel as a link or as a sealed box
 * into the invitee's inbox (addressed by pubkey).
 */
import { createPeer, createQu, sync, mirror, connectInProcess } from '@qu/lite';

const until = async (check) => { while (!(await check())) await new Promise((r) => setTimeout(r, 10)); };

// A blind mirror in the same process (over the network: 03-mirror-websocket.mjs).
const relay = await createQu();
relay.use(sync({ role: 'mirror' }));
relay.use(mirror());

async function person() {
  const qu = await createPeer({ plugins: ['records', 'user', 'members', 'inbox', 'sync'] });
  await connectInProcess(qu, relay).ready;
  await qu.inbox.ready;
  return qu;
}
const [alice, bob, carol] = [await person(), await person(), await person()];
const pubOf = (qu) => Buffer.from(qu.identity.publicKey).toString('hex');

// User nodes: public profile fields anyone with the pubkey can read, private fields only own devices.
const me = await alice.me();
await me.set('name', 'Alice');
await me.set('phone', '+49 …', { visibility: 'private' });
const aliceSeenByBob = await bob.user(pubOf(alice));
await until(async () => (await aliceSeenByBob.get('name')) === 'Alice');
console.log('bob reads alice\'s profile:', await aliceSeenByBob.fields());

// Alice founds a group and invites bob by pubkey (sealed box into his inbox) ...
const group = await alice.createGroup();
const admin = await alice.members(group);
const accepted = new Promise((resolve) =>
  bob.bus.on('qu.inbox.message', async ({ payload }) => payload.type === 'invite' && resolve(await bob.acceptInvite(payload)))
);
await admin.invite(pubOf(bob));
const groupOfBob = await accepted;

// ... and carol by link (the invite object; put it in a URL fragment, a QR code, ...).
const link = await admin.invite();
const groupOfCarol = await carol.acceptInvite(link);

await until(async () => (await bob.members(groupOfBob)).list().length === 3);
await (await bob.members(groupOfBob)).reveal({ name: 'Bob' });   // optional, verifiable, members only
await until(async () => admin.list().some((m) => m.name === 'Bob'));
console.log('members (alice\'s view):', admin.list().map((m) => `${m.alias.slice(0, 8)} ${m.role}${m.name ? ` (${m.name})` : ''}`));

await bob.write(groupOfBob, 'chat', 'hi all');
await until(async () => (await carol.query({ space: groupOfCarol, path: 'chat' })).length === 1);

// Roles: the owner promotes carol to admin; an admin may remove members.
const carolAlias = (await carol.members(groupOfCarol)).me;          // each member knows its own alias
const bobAlias = admin.list().find((m) => m.name === 'Bob').alias;
await admin.promote(carolAlias, 'admin');
await until(async () => (await carol.members(groupOfCarol)).isAdmin());
const epoch = await (await carol.members(groupOfCarol)).remove(bobAlias);
console.log('bob removed by carol, new epoch', epoch);

await until(async () => group.epoch === epoch);
await alice.write(group, 'chat', 'bob cannot read this');
await until(async () => (await carol.query({ space: groupOfCarol, path: 'chat' })).length === 2);
console.log('carol reads:', (await carol.query({ space: groupOfCarol, path: 'chat' })).map((r) => r.value));
await until(async () => (await bob.members(groupOfBob)).role() === 'removed');
console.log('bob\'s role:', (await bob.members(groupOfBob)).role(), '- bob\'s epoch is still', groupOfBob.epoch);

// After a reload: `await qu.restoreGroups()` reopens every group this device joined.
