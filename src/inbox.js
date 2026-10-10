/**
 * INBOX - one mailbox per identity, reachable by its pubkey (space.js
 * `Space.inbox`). Anyone can drop a message; only the owner can read it:
 *
 *   msg  (public envelope, signed by a ONE-TIME key)  {box}
 *        box = anonymous sealed box (crypto.sealTo) to the owner's `epub`,
 *        read from the owner's user node.
 *
 * A relay or mirror sees only "the mailbox with this opaque id received N
 * bytes" - no sender, no content, and the recipient's identity only to
 * someone who already knows the pubkey. Used for invites (members.js) and
 * later for direct messages.
 *
 *   qu.inbox.send(pubHex, {type: 'invite', ...})
 *   qu.bus.on('qu.inbox.message', ({id, payload, at}) => ...)
 *   await qu.inbox.messages()
 *
 * `enabled: false` neither announces nor subscribes the own inbox (no one
 * can reach you this way). Needs `records()`, `user()`; uses `sync()`.
 */
import * as crypto from './crypto.js';
import { Space, inboxSidOf } from './space.js';

const PATH = 'msg';

/** @param {{enabled?: boolean, maxBytes?: number, epubTimeoutMs?: number}} [options] */
export function inbox({ enabled = true, maxBytes = 64 * 1024, epubTimeoutMs = 5000 } = {}) {
  return (qu) => {
    if (typeof qu.me !== 'function') throw new Error('inbox(): install records() and user() first');
    const { bus, identity } = qu;
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    async function open(record) {
      const plain = await crypto.openSealed(identity.xPrivateKey, identity.xPublicKey, crypto.fromBase64(record.value?.box ?? ''));
      if (!plain) return null;
      try {
        return { id: record.id, at: Number(record.hlc.slice(0, 13)), payload: JSON.parse(dec.decode(plain)) };
      } catch {
        return null;
      }
    }

    const ready = (async () => {
      await qu.me(); // publishes the epub senders encrypt to
      const space = qu.join(await Space.inbox(identity.publicKey), { mirror: enabled });
      if (enabled) {
        bus.on(`qu.record.${space.id}`, async (record) => {
          const message = await open(record);
          if (message) await bus.notify('qu.inbox.message', message);
        });
        if (typeof qu.watch === 'function') await qu.watch({ space });
      }
      return space;
    })();

    async function epubOf(pubHex) {
      const node = await qu.user(pubHex);
      const deadline = Date.now() + epubTimeoutMs;
      for (;;) {
        const epub = await node.get('epub');
        if (epub) return crypto.fromHex(epub);
        if (Date.now() > deadline) throw new Error(`inbox: no epub published for ${pubHex.slice(0, 8)}…`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    const api = {
      ready,
      /**
       * Drops an encrypted message into someone's inbox.
       * @param {string} pubHex - the recipient's identity pubkey
       * @param {object} payload - JSON
       */
      async send(pubHex, payload) {
        const bytes = enc.encode(JSON.stringify(payload));
        if (bytes.length > maxBytes) throw new Error('inbox: message too large');
        const epub = await epubOf(pubHex);
        const target = qu.space(crypto.toHex(await inboxSidOf(crypto.fromHex(pubHex)))) ?? qu.join(await Space.inbox(crypto.fromHex(pubHex)));
        const box = crypto.toBase64(await crypto.sealTo(epub, bytes));
        return qu.write(target, PATH, { box }, { visibility: 'public' });
      },
      /** @returns {Promise<Array<{id: string, at: number, payload: object}>>} readable messages, oldest first */
      async messages() {
        const space = await ready;
        const out = [];
        for (const record of await qu.query({ space, path: PATH })) {
          const message = await open(record);
          if (message) out.push(message);
        }
        return out;
      },
    };
    qu.inbox = api;
    return api;
  };
}
