/**
 * Shared setup for examples 05-07 (not an example itself): a blind mirror
 * and two members of one group, connected in-process.
 */
import { createPeer, createQu, sync, mirror, connectInProcess } from '@qu/lite';

export const until = async (check, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** @param {Array<string|[string, object]>} extraPlugins - e.g. ['status'] */
export async function twoMembers(extraPlugins = []) {
  const relay = await createQu();
  relay.use(sync({ role: 'mirror' }));
  relay.use(mirror());
  const person = async () => {
    const qu = await createPeer({ plugins: ['records', 'user', 'members', 'inbox', 'sync', ...extraPlugins] });
    qu.link = connectInProcess(qu, relay);
    await qu.link.ready;
    await qu.inbox.ready;
    return qu;
  };
  const alice = await person();
  const bob = await person();
  const groupA = await alice.createGroup();
  const groupB = await bob.acceptInvite(await (await alice.members(groupA)).invite());
  await until(async () => (await alice.members(groupA)).list().length === 2 && (await bob.members(groupB)).list().length === 2);
  return { relay, alice, bob, groupA, groupB };
}
