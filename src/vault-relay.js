/**
 * TRESOR STORE at the relay (keys.js): the encrypted identity of users who
 * unlock with a security key or passkey, one entry per registered key under
 * SHA-256(credential id). The relay never holds anything it could open.
 *
 *   GET  /id/<handle>   -> {vault}                               (404: none)
 *   POST /id/<handle>   {vault | null, pub, at, sig}             store / delete
 *
 * Writes are signed by the identity inside (Ed25519 over
 * `qu-lite/vault\n<handle>\n<sha256(vault json)>\n<at>`): the first write
 * binds the handle to that identity, later ones must come from it, and
 * `at` must grow (no replay of an older tresor). Bounded: entry size, count,
 * request rate. Installed by mirror.js.
 */
import * as crypto from './crypto.js';
import { route, json, httpError, readJson, rateLimit } from './net/http.js';
import { vaultMessage } from './keys.js';

const HANDLE = /^[0-9a-f]{64}$/;
const enc = new TextEncoder();

/** @param {{maxBytes?: number, maxEntries?: number, rate?: number}} [options] */
export function vaultRelay(qu, { maxBytes = 256 * 1024, maxEntries = 100_000, rate = 20 } = {}) {
  const { storage } = qu;
  const writeLimit = rateLimit(rate);
  const readLimit = rateLimit(rate * 10);
  const key = (handle) => `vault/${handle}`;
  let count = null;

  route(qu, 'GET', '/id/', async (req, res, url) => {
    readLimit();
    const handle = url.pathname.slice(4);
    if (!HANDLE.test(handle)) throw httpError(400, 'expected /id/<sha256 hex>');
    const entry = await storage.get(key(handle));
    if (!entry?.vault) throw httpError(404, 'no tresor for this key');
    json(res, 200, { vault: JSON.parse(entry.vault) });
  });

  route(qu, 'POST', '/id/', async (req, res, url) => {
    writeLimit();
    const handle = url.pathname.slice(4);
    if (!HANDLE.test(handle)) throw httpError(400, 'expected /id/<sha256 hex>');
    const { vault, pub, at, sig } = (await readJson(req, maxBytes + 4096)) ?? {};
    if (typeof pub !== 'string' || !/^[0-9a-f]{64}$/.test(pub) || !Number.isSafeInteger(at) || Math.abs(Date.now() - at) > 10 * 60_000 || typeof sig !== 'string') throw httpError(400, 'bad request');
    const body = vault ? JSON.stringify(vault) : '';
    if (body.length > maxBytes) throw httpError(413, 'tresor too large');
    if (vault && (vault.pub !== pub || !Array.isArray(vault.wraps) || typeof vault.data !== 'string')) throw httpError(400, 'malformed tresor');
    const digest = crypto.toHex(await crypto.sha256(enc.encode(body)));
    let valid = false;
    try {
      valid = await crypto.verify(vaultMessage(handle, digest, at), crypto.fromBase64(sig), crypto.fromHex(pub));
    } catch {}
    if (!valid) throw httpError(403, 'bad signature');
    const current = await storage.get(key(handle));
    if (current && current.pub !== pub) throw httpError(403, 'this key belongs to another identity');
    if (current && at <= current.at) throw httpError(409, 'older than the stored tresor');
    if (!vault) {
      if (current) {
        await storage.remove(key(handle));
        if (count !== null) count--;
      }
      return json(res, 200, { ok: true });
    }
    if (!current) {
      count ??= (await storage.keys('vault/')).length;
      if (count >= maxEntries) throw httpError(503, 'tresor store full');
      count++;
    }
    await storage.set(key(handle), { pub, at, vault: body });
    json(res, 200, { ok: true });
  });
}
