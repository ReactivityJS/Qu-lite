/**
 * 07 - Collaborative text (optional plugin): concurrent edits merge.
 *
 *   node examples/07-text.mjs
 *
 * An RGA text CRDT on top of ordinary encrypted records: keystrokes within
 * `batchMs` become one record, offline edits merge on reconnect, and anchors
 * keep a caret in place across remote edits. Only bundled when imported.
 */
import { connectInProcess } from '@qu/lite';
import { twoMembers, until } from './_group.mjs';

const { relay, alice, bob, groupA, groupB } = await twoMembers([['text', { batchMs: 50 }]]);
const docA = await alice.text(groupA, 'notes/main');
const docB = await bob.text(groupB, 'notes/main');
docB.on(({ text, remote }) => remote && console.log('bob sees:', JSON.stringify(text)));

docA.insert(0, 'Hello world');
await until(() => docB.value() === 'Hello world');

// Bob's caret sits before "world"; both edit concurrently while offline.
const caret = docB.anchor(6);
await alice.link.disconnect();
docA.insert(5, ',');                         // "Hello, world"
docB.insert(docB.value().length, '!');       // "Hello world!"
docB.set('Hi world!');                       // set(): the smallest single edit from a new full value
await docA.flush();

alice.link = connectInProcess(alice, relay);
await until(() => docA.value() === docB.value() && docA.value().includes(',') && docA.value().endsWith('!'));
console.log('merged:', JSON.stringify(docA.value()));
console.log('bob\'s caret is still before "world" at index', docB.indexOf(caret), '->', JSON.stringify(docB.value().slice(docB.indexOf(caret))));

await docA.compact();                        // snapshot own state, drop own batches
console.log('alice stats after compact:', docA.stats());
await docA.close();
await docB.close();
