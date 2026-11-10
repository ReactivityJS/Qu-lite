/**
 * ARCHIVE (optional plugin) - spaces as one file: backup, moving to another
 * relay, an offline copy, handing a group's history over.
 *
 *   qu.use(archive())                              // or createClient({ extra: ['archive'] })
 *   const file = await qu.archive.export({ spaces: [group] });        // Uint8Array
 *   const all  = await qu.archive.export({ passphrase });             // every space + identity and keys
 *   await qu.archive.download({ passphrase });                         // browser: as a file
 *
 *   // another device or relay
 *   const { backup } = readArchive(all);                               // the sealed key backup inside
 *   const qu = await createClient({ url, restore: { backup, passphrase }, extra: ['archive'] });
 *   await qu.archive.import(all);        // {stored, duplicate, rejected}; opens the restored groups itself
 *
 * What is inside: the SEALED envelopes as stored (still encrypted and
 * signed) and each space's grants; with `passphrase`, also a device backup
 * (device.js, PBKDF2 + AES-GCM) of identity, group and epoch keys. Without
 * a passphrase an archive is unreadable to anyone without the keys - safe to
 * keep in a cloud drive. Import verifies every grant and every envelope
 * like records from the network; nothing is trusted because it came from a
 * file. Works on clients and on relays (moving a relay: export there,
 * import here).
 *
 * Format: `QUARCH1\n`, u32 header length, header JSON
 * {v, created, backup?, spaces: [{sid, grants, count}]}, then the envelopes
 * (http.js packEnvelopes) in header order.
 */
import { packEnvelopes, unpackEnvelopes } from './net/http.js';
import { encodeBytes, decodeBytes } from './public.js';

const MAGIC = new TextEncoder().encode('QUARCH1\n');
const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Reads an archive's header and envelopes without importing anything.
 * @param {Uint8Array} bytes
 * @returns {{created: number, backup: string|null, spaces: Array<{sid: string, grants: object[], envelopes: Uint8Array[]}>}}
 */
export function readArchive(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < MAGIC.length + 4 || MAGIC.some((b, i) => bytes[i] !== b)) throw Object.assign(new Error('archive: not a Qu archive'), { code: 'QU_ARCHIVE_INVALID' });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(MAGIC.length);
  const start = MAGIC.length + 4;
  let header;
  try {
    header = JSON.parse(dec.decode(bytes.subarray(start, start + headerLength)));
  } catch {
    throw Object.assign(new Error('archive: damaged header'), { code: 'QU_ARCHIVE_INVALID' });
  }
  const envelopes = unpackEnvelopes(bytes.subarray(start + headerLength));
  if (header?.v !== 1 || !Array.isArray(header.spaces) || !envelopes) throw Object.assign(new Error('archive: damaged or unknown version'), { code: 'QU_ARCHIVE_INVALID' });
  let at = 0;
  const spaces = header.spaces.map(({ sid, grants, count }) => ({ sid, grants: decodeBytes(grants), envelopes: envelopes.slice(at, (at += count)) }));
  if (at !== envelopes.length) throw Object.assign(new Error('archive: damaged (envelope count)'), { code: 'QU_ARCHIVE_INVALID' });
  return { created: header.created, backup: header.backup ?? null, spaces };
}

export function archive() {
  const plugin = (qu) => {
    const { storage } = qu;
    /** the space's grants: from the joined space, else what a relay keeps */
    const grantsOf = async (sid) => (await qu.space?.(sid)?.grants?.()) ?? (await storage.get(`mirror/grants/${sid}`)) ?? [];
    /** every space this peer holds envelopes of */
    const allSpaces = async () => [...new Set((await storage.keys('rec/')).map((k) => k.split('/')[1]))];

    const api = {
      /**
       * @param {{spaces?: Array<object|string>, passphrase?: string}} [options]
       *   `spaces`: which (Space or sid; default: all held here). `passphrase`: also seal identity
       *   and keys into the file (a device backup) - then the file alone restores a user.
       * @returns {Promise<Uint8Array>}
       */
      async export({ spaces, passphrase } = {}) {
        const sids = spaces ? spaces.map((s) => (typeof s === 'string' ? s : s.id)) : await allSpaces();
        const header = { v: 1, created: Date.now(), spaces: [] };
        const list = [];
        for (const sid of sids) {
          const rows = await storage.range(`rec/${sid}/`, {});
          header.spaces.push({ sid, grants: encodeBytes(await grantsOf(sid)), count: rows.length });
          for (const { value } of rows) list.push(value);
        }
        if (passphrase !== undefined) {
          if (!qu.device?.exportBackup) throw new Error('archive: a passphrase needs the device plugin');
          header.backup = await qu.device.exportBackup(passphrase);
        }
        const head = enc.encode(JSON.stringify(header));
        const body = packEnvelopes(list);
        const out = new Uint8Array(MAGIC.length + 4 + head.length + body.length);
        out.set(MAGIC, 0);
        new DataView(out.buffer).setUint32(MAGIC.length, head.length);
        out.set(head, MAGIC.length + 4);
        out.set(body, MAGIC.length + 4 + head.length);
        await qu.bus.notify('qu.archive.exported', { spaces: sids.length, envelopes: list.length, bytes: out.length });
        return out;
      },

      /** Browser: offers the export as a file. @returns {Promise<number>} bytes */
      async download(options = {}, filename = `qu-archive-${new Date().toISOString().slice(0, 10)}.quarchive`) {
        const bytes = await api.export(options);
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
        Object.assign(document.createElement('a'), { href: url, download: filename }).click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        return bytes.length;
      },

      /**
       * Imports an archive: grants are verified into the keyring, every envelope is
       * ingested as if it came from the network (signatures, quotas, rules).
       * @param {Uint8Array} bytes
       * @returns {Promise<{spaces: number, stored: number, duplicate: number, rejected: number}>} `stored` includes
       *   older versions of keyed entries (kept as the network would)
       */
      async import(bytes) {
        const { spaces } = readArchive(bytes);
        const counts = { spaces: spaces.length, stored: 0, duplicate: 0, rejected: 0 };
        // open the groups this device has keys for first, so their records are indexed, not kept blind
        await qu.restoreGroups?.();
        for (const { sid, grants, envelopes } of spaces) {
          if (grants.length) await qu.keyring.accept(sid, grants);
          for (const envelope of envelopes) {
            const { status } = await qu.envelopes.ingest(envelope.slice(), { from: undefined, sync: true });
            // superseded (an older version of a keyed entry) and gone (dropped since) are fine
            if (status === 'rejected' || status === 'failed') counts.rejected++;
            else counts[status === 'duplicate' ? 'duplicate' : 'stored']++;
          }
        }
        await qu.bus.notify('qu.archive.imported', counts);
        return counts;
      },
    };
    qu.archive = api;
    return api;
  };
  plugin.pluginName = 'archive';
  return plugin;
}
