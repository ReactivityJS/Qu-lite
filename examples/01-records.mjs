/**
 * 01 - Records on one peer: write, read, query, hooks and listeners.
 *
 *   node examples/01-records.mjs
 *
 * A space is an encrypted container (a group, a document, a chat). Records
 * are either log entries (append-only) or keyed entries (last-write-wins).
 * Everything is stored sealed; reads decrypt on demand.
 */
import { createQu, records, Space } from '@qu/lite';

const qu = await createQu();                 // memory storage, fresh identity
qu.use(records());
const space = qu.join(await Space.create(qu.identity));

// Hook: a transform step before every local write (throw to veto).
qu.bus.on('qu.write.before', (draft) => (typeof draft.value === 'string' ? { value: draft.value.trim() } : {}));
// Listener: every record of this space, local or remote, after it is durable.
qu.bus.on(`qu.record.${space.id}`, (rec) => console.log('record', rec.path, rec.key ?? '-', JSON.stringify(rec.value)));

// Log entries (no key): append-only, ordered by hybrid logical clock.
await qu.write(space, 'chat/general', '  hello  ');
await qu.write(space, 'chat/general', { text: 'second message', at: Date.now() });

// Keyed entries: the newest version wins; get() returns the current value.
await qu.write(space, 'settings', 'light', { key: 'theme' });
await qu.write(space, 'settings', 'dark', { key: 'theme' });
console.log('theme =', await qu.get(space, 'settings', 'theme'));

// Time-window query over one path (from inclusive, to exclusive, wall-clock ms).
const lastHour = await qu.query({ space, path: 'chat/general', from: Date.now() - 3600_000 });
console.log('messages:', lastHour.map((r) => r.value));
const newest = await qu.query({ space, path: 'chat/general', limit: 1, reverse: true });
console.log('newest id:', newest[0].id.slice(0, 16), 'author (alias):', newest[0].author.slice(0, 16));

// A veto: the hook throws, the write is refused and nothing is stored.
qu.bus.on('qu.write.before', (draft) => {
  if (draft.path === 'chat/general' && draft.value === '') throw new Error('empty messages are not allowed');
});
await qu.write(space, 'chat/general', '   ').catch((error) => console.log('refused:', error.message));

// Local integrity check: verifies every stored envelope without decrypting.
console.log('scrub:', await qu.scrub(space));
