/**
 * 11 - A multiplayer game: live moves as signals, the game state as records,
 *      a leaderboard by field.
 *
 *   node examples/11-game.mjs
 *
 * SIGNALS (`qu.signal`) are sealed and signed like records but never stored:
 * right for cursor positions, moves in flight, "ready?". The STATE that must
 * survive (whose turn, the board, the score) is records: synced, offline
 * safe, the same on every device. Keyed entries are last-write-wins; a turn
 * order makes every move a new version from the player whose turn it is.
 */
import { twoMembers, until } from './_group.mjs';

const { alice, bob, groupA, groupB } = await twoMembers(['signals']);
const aliceAlias = (await alice.members(groupA)).me;
const bobAlias = (await bob.members(groupB)).me;

// live: bob sees alice's pointer while she thinks
const seen = [];
bob.bus.on(`qu.signal.${groupB.id}.pointer`, ({ author, value }) => seen.push({ who: author.slice(0, 6), ...value }));
await alice.signal(groupA, 'pointer', { x: 3, y: 4 });
await until(() => seen.length === 1);
console.log('bob sees alice pointing at', seen[0]);

// state: the board and whose turn it is, as keyed records
await alice.write(groupA, 'game', { board: ['X', null, null], turn: bobAlias, round: 1 }, { key: 'state' });
await until(async () => (await bob.get(groupB, 'game', 'state'))?.turn === bobAlias);
const state = await bob.get(groupB, 'game', 'state');
await bob.write(groupB, 'game', { board: ['X', 'O', null], turn: aliceAlias, round: 1 }, { key: 'state' });
console.log('bob moved:', state.board, '->', ['X', 'O', null]);

// results as log entries; the leaderboard is a field query
for (const [who, points] of [['alice', 120], ['bob', 90], ['alice', 75], ['bob', 140]]) {
  await (who === 'alice' ? alice.write(groupA, 'scores', { who, points, round: 1 }) : bob.write(groupB, 'scores', { who, points, round: 1 }));
}
await until(async () => (await alice.query({ space: groupA, path: 'scores' })).length === 4);
const top = await alice.query({ space: groupA, path: 'scores', where: { round: 1 }, orderBy: 'points', reverse: true, limit: 3 });
console.log('top 3:', top.map((r) => `${r.value.who} ${r.value.points}`));

await alice.close();
await bob.close();
