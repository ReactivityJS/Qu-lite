/**
 * 10 - Calendar: queries by field (any app, nothing calendar-specific).
 *
 *   node examples/10-calendar.mjs
 *
 * Events are keyed entries (the key is the event id: editing = a new version,
 * last write wins). `where` / `orderBy` work on any field of the value:
 * ranges, equality, arrays ("contains"), prefix and search - the same for a
 * task list, a shop or a game. Indexes are built in memory on first use and
 * follow every change, also those arriving from other devices.
 */
import { twoMembers, until } from './_group.mjs';

const { alice, bob, groupA, groupB } = await twoMembers(['compaction']); // compaction: qu.del()
const at = (day, hour) => Date.UTC(2026, 10, day, hour);
const plan = (qu, space, id, event) => qu.write(space, 'events', event, { key: id });

await plan(alice, groupA, 'dentist', { title: 'Zahnarzt', start: at(12, 8), end: at(12, 9), tags: ['health'] });
await plan(alice, groupA, 'standup', { title: 'Standup', start: at(10, 9), end: at(10, 9.25), tags: ['work'] });
await plan(bob, groupB, 'review', { title: 'Review', start: at(11, 14), end: at(11, 15), tags: ['work'], place: { city: 'Berlin' } });

const week = { space: groupA, path: 'events', where: { start: { gte: at(9, 0), lt: at(16, 0) } }, orderBy: 'start' };
await until(async () => (await alice.query(week)).length === 3); // bob's event arrived by sync
console.log('this week:', (await alice.query(week)).map((r) => r.value.title));

console.log('work:', (await alice.query({ space: groupA, path: 'events', where: { tags: 'work' }, orderBy: 'start' })).map((r) => r.value.title));
console.log('in Berlin:', (await alice.query({ space: groupA, path: 'events', where: { 'place.city': 'Berlin' } })).map((r) => r.value.title));
console.log('search "arzt":', (await alice.query({ space: groupA, path: 'events', where: { title: { contains: 'arzt' } } })).map((r) => r.value.title));

// bob moves the review to next week: it leaves this week's result at alice's
await plan(bob, groupB, 'review', { title: 'Review', start: at(18, 14), end: at(18, 15), tags: ['work'] });
await until(async () => (await alice.query(week)).length === 2);
console.log('after the move:', (await alice.query(week)).map((r) => r.value.title));

// a deleted event leaves too
await alice.del(groupA, 'events', 'standup');
console.log('after deleting:', (await alice.query(week)).map((r) => r.value.title));

await alice.close();
await bob.close();
