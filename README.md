# @qu/lite

A small, event-driven Qu core. Milestone 1 of the plan in this branch: kernel, mounts, Space keys,
metadata-hiding envelope, records as bus processes, and an in-process network bridge. No sync/
reconciliation, persistent drivers, mirror or status yet.

```js
import { createQu, records, Space, connectInProcess } from '@qu/lite';

const qu = await createQu();
qu.use(records());
const space = qu.join(await Space.create());

qu.bus.on('qu.write.before', (draft) => ({ value: draft.value.trim() })); // hook
qu.bus.on(`qu.record.${space.id}`, (rec) => console.log(rec.path, rec.value)); // listener

await qu.write(space, 'chat/general', ' hallo ');
await qu.write(space, 'profile', 'Anna', { key: 'name' }); // last-write-wins
await qu.query({ space, path: 'chat/general', from: Date.now() - 3600_000 });
```

- **Kernel** (`qu.js`): `EventBus` (`@qu/events`) + mount router + registry; everything else is `qu.use(plugin)`.
- **Mounts** (`mount.js`): unstorage-style, longest prefix wins; drivers implement `get/set/remove/keys`, optionally `range`.
- **Space** (`space.js`): 32-byte secret → opaque `sid`, shard HMAC key, epoch keys, per-epoch write key; `rotate()`/`acceptEpoch()` for member removal; `Space.forUser(identity)`.
- **Envelope** (`envelope.js`): public header is only `sid`, `shard`, `epoch`, minute-rounded `ts`, plus the space write signature; path, key, precise HLC, author and value are encrypted and author-signed inside. One ciphertext per record, no recipient list.
- **Records** (`records.js`): `write/get/query`; write = `qu.write.before` → seal → store → `qu.record.<sid>` → `net.out.<peer>.rec`; receive = dedupe → open → drift check → `qu.accept` (stoppable) → store → forward.
- **Network** (`net/inproc.js`): a bridge maps `net.out.<peer>.*` to `net.in.<peer>.*` on the other bus.
