// Compiled with `npm run types` (tsc --noEmit): an app written against the published types.
// The @ts-expect-error lines prove that the types catch mistakes.
import { createClient, fetchPublic } from '@qu/lite';
import { createRelay } from '@qu/lite/node';

async function main(): Promise<void> {
  const relay = await createRelay({ port: 0, log: () => {} });
  const qu = await createClient({ url: [`http://127.0.0.1:${relay.port}`], name: 'typed-app', passphrase: 'a long passphrase' });

  const group = await qu.createGroup();
  const rec = await qu.write(group, 'chat', { text: 'hallo' });
  const text: string = rec.value.text;
  const list = await qu.query<{ text: string }>({ space: group, path: 'chat', from: Date.now() - 3600_000 });
  list.forEach((r) => r.value.text.toUpperCase());

  const m = await qu.members(group);
  const invite = await m.invite(null, { expiresIn: 24 * 3600_000 });
  await qu.acceptInvite(invite);

  const st = await qu.status(group);
  st.isOnline(m.me);
  qu.status.setHidden(true);

  const backup: string = await qu.device.exportBackup('a long passphrase');
  const status = await qu.device.status();
  const locked: boolean = status.locked;
  qu.dev.watchTraffic(10)();
  const { outbox } = await qu.syncStatus();
  qu.transports.relay.urls?.length;

  // @ts-expect-error - write needs a space
  await qu.write('chat', 'x');
  // @ts-expect-error - query takes an options object
  await qu.query(group, 'chat');
  // @ts-expect-error - backup passphrase must be a string
  await qu.device.exportBackup(42);

  const forum = await qu.createGroup({ open: true });
  const link = await (await qu.members(forum)).link();
  const posts = await fetchPublic(`http://127.0.0.1:${relay.port}`, forum.id, 'posts', { limit: 10 });
  posts.map((p) => p.value);
  const { records } = await qu.background.progress();
  await qu.push.ring(forum);

  await qu.close();
  await relay.close();
  void [link, records];
  void [text, backup, locked, outbox];
}
void main;
