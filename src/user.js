/**
 * USER NODES - every identity has a home space reachable by its PUBKEY
 * (space.js `Space.user`), written only by its owner:
 *
 *   profile/<field>   public: signed plaintext, anyone with the pubkey reads
 *                     it (the `epub` for encrypting to this user, a display
 *                     name, custom public fields)
 *   private/<field>   private: encrypted with a key only the owner's devices
 *                     derive - settings, own spaces, anything personal
 *
 * Public and private fields live under different paths, so a visitor only
 * subscribes to (and receives) the public shard - private envelopes never
 * even reach other people's devices.
 *
 *   const me = await qu.me();             me.set('name', 'Anna'); me.set('phone', '…', {visibility: 'private'})
 *   const anna = await qu.user(pubHex);   await anna.get('name'); await anna.fields()
 *
 * Needs `records()`; uses `sync()` (if installed) to fetch other users' nodes.
 */
import * as crypto from './crypto.js';
import { Space } from './space.js';

const PUBLIC = 'profile';
const PRIVATE = 'private';

export function user() {
  return (qu) => {
    if (typeof qu.write !== 'function') throw new Error('user(): install records() first');
    /** @type {Map<string, Promise<object>>} */
    const nodes = new Map();
    const myId = crypto.toHex(qu.identity.publicKey);

    const fieldsOf = async (space, path) => {
      const out = {};
      for (const record of await qu.query({ space, path })) out[record.key] = record.value;
      return out;
    };

    function viewOf(space) {
      return {
        space,
        /** @type {string} the owner's identity pubkey (hex) */
        id: space.ownerId,
        /** @param {string} field @returns {Promise<*|null>} a public field */
        get: (field) => qu.get(space, PUBLIC, field),
        /** @returns {Promise<Record<string, *>>} all public fields */
        fields: () => fieldsOf(space, PUBLIC),
      };
    }

    /** The own user node: read/write, public and private fields. */
    function me() {
      if (!nodes.has(myId)) {
        nodes.set(
          myId,
          (async () => {
            const space = qu.join(await Space.user(qu.identity.publicKey, qu.identity), { author: 'identity' });
            if (typeof qu.watch === 'function') await qu.watch({ space });
            const view = viewOf(space);
            Object.assign(view, {
              /**
               * @param {string} field
               * @param {*} value
               * @param {{visibility?: 'public'|'private'}} [options]
               */
              set: (field, value, { visibility = 'public' } = {}) =>
                qu.write(space, visibility === 'public' ? PUBLIC : PRIVATE, value, { key: field, visibility }),
              /** @param {string} field @returns {Promise<*|null>} a private field */
              getPrivate: (field) => qu.get(space, PRIVATE, field),
              privateFields: () => fieldsOf(space, PRIVATE),
            });
            if ((await view.get('epub')) === null) await view.set('epub', crypto.toHex(qu.identity.xPublicKey));
            return view;
          })()
        );
      }
      return nodes.get(myId);
    }

    /**
     * Someone's user node by pubkey: public fields only, fetched (and kept
     * live) via sync when installed.
     * @param {string} pubHex
     */
    function userNode(pubHex) {
      if (pubHex === myId) return me();
      if (!nodes.has(pubHex)) {
        nodes.set(
          pubHex,
          (async () => {
            const space = qu.join(await Space.user(crypto.fromHex(pubHex)));
            if (typeof qu.watch === 'function') await qu.watch({ space, path: PUBLIC });
            return viewOf(space);
          })()
        );
      }
      return nodes.get(pubHex);
    }

    Object.assign(qu, { me, user: userNode });
    return { me, user: userNode };
  };
}
