/**
 * 12 - Forum and blog: an open space anyone with the link may write to,
 *      moderation, and reading without membership over plain HTTP.
 *
 *   node examples/12-forum-blog.mjs
 *
 * A BLOG is a group whose members are its authors; posts are written
 * `visibility: 'public'` and read by anyone with `fetchPublic()` - no
 * identity, no peer, every record verified by the reader. A FORUM is an
 * OPEN group: `link()` lets anyone write; owner and admins ban aliases and
 * delete posts, and the relay enforces bans and a per-author rate limit.
 */
import { createClient, fetchPublic, publicLink } from '@qu/lite';
import { createRelay } from '@qu/lite/node';

const relay = await createRelay({ port: 0, log: () => {} });
const url = `http://127.0.0.1:${relay.port}`;
const until = async (check) => { while (!(await check())) await new Promise((r) => setTimeout(r, 20)); };
const synced = (qu) => until(async () => (await qu.syncStatus()).outbox === 0);

// --- blog -------------------------------------------------------------------
const author = await createClient({ url, devtools: false });
const blog = await author.createGroup();
await author.write(blog, 'posts', { title: 'Hallo Welt', body: '...' }, { key: 'hallo-welt', visibility: 'public' });
await author.write(blog, 'posts', { title: 'Offline first', body: '...' }, { key: 'offline-first', visibility: 'public' });
await author.write(blog, 'drafts', { title: 'Noch geheim' }); // private: never served to readers
await synced(author);
const link = publicLink(url, blog.id, 'posts');
console.log('blog link:', link.replace(url, '<relay>'));
console.log('a reader sees:', (await fetchPublic(link)).map((r) => r.value.title));

// --- forum ------------------------------------------------------------------
const mod = await createClient({ url, devtools: false });
const forum = await mod.createGroup({ open: true });
const invite = await (await mod.members(forum)).link(); // publish this, e.g. as a QR code

const guest = await createClient({ url, devtools: false });
const troll = await createClient({ url, devtools: false });
const g = await guest.acceptInvite(invite);
const t = await troll.acceptInvite(invite);
await guest.write(g, 'posts', { thread: 'welcome', text: 'Hallo zusammen!' }, { visibility: 'public' });
const spam = await troll.write(t, 'posts', { thread: 'welcome', text: 'BUY NOW' }, { visibility: 'public' });
await until(async () => (await mod.query({ space: forum, path: 'posts' })).length === 2);

const m = await mod.members(forum);
await m.ban((await troll.members(t)).me);   // from now on refused by every member and the relay
await mod.del(forum, spam.id);               // and the spam is deleted for everyone
await until(async () => (await guest.query({ space: g, path: 'posts' })).length === 1);
await synced(mod);
const thread = await fetchPublic(url, forum.id, 'posts');
console.log('thread "welcome" for guests:', thread.filter((r) => r.value.thread === 'welcome').map((r) => r.value.text));
try {
  await troll.write(t, 'posts', { thread: 'welcome', text: 'again' });
} catch (error) {
  console.log('the banned alias:', error.message);
}

for (const qu of [author, mod, guest, troll]) await qu.close();
await relay.close();
