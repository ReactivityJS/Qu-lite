/**
 * HTTP ROUTES - plugins add plain HTTP endpoints to a relay without knowing
 * the server: they register here, the HTTP server transport (ws-server.js)
 * asks every route before it serves static files. No Node import, so a
 * plugin that registers routes (mirror, push-relay) stays browser-safe - in
 * a browser nothing ever calls them.
 *
 *   route(qu, 'GET', '/q/', async (req, res, url) => json(res, 200, {...}))
 *
 * Everything under a route answers CORS for any origin: apps may live on
 * another origin than their relay, and the data is either public or sealed.
 */

/** @returns {{routes: Array<{method: string, prefix: string, handler: Function}>}} */
export function httpOf(qu) {
  qu.http ??= { routes: [] };
  return qu.http;
}

/**
 * @param {object} qu
 * @param {'GET'|'POST'} method
 * @param {string} prefix - path prefix, e.g. '/q/' or '/push/subscribe'
 * @param {(req: any, res: any, url: URL) => any} handler
 * @returns {() => void} removes the route
 */
export function route(qu, method, prefix, handler) {
  const entry = { method, prefix, handler };
  httpOf(qu).routes.push(entry);
  const remove = () => {
    const list = httpOf(qu).routes;
    if (list.includes(entry)) list.splice(list.indexOf(entry), 1);
  };
  qu.onClose?.(remove);
  return remove;
}

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

/**
 * Serves `req` if a route matches. @returns {boolean} whether it was handled
 */
export function dispatch(qu, req, res) {
  const routes = qu.http?.routes;
  if (!routes?.length) return false;
  const url = new URL(req.url, 'http://x');
  const matching = routes.filter((r) => url.pathname.startsWith(r.prefix));
  if (!matching.length) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return true;
  }
  const hit = matching.find((r) => r.method === req.method || (r.method === 'GET' && req.method === 'HEAD'));
  if (!hit) {
    res.writeHead(405, { ...CORS, 'content-type': 'text/plain' }).end('method not allowed');
    return true;
  }
  Promise.resolve()
    .then(() => hit.handler(req, res, url))
    .catch((error) => {
      qu.bus?.error?.(error, `http ${hit.prefix}`);
      if (!res.headersSent) res.writeHead(error.status ?? 500, { ...CORS, 'content-type': 'text/plain' });
      res.end(error.status ? error.message : 'internal error');
    });
  return true;
}

/** Sends JSON (no caching unless `cache` seconds are given). */
export function json(res, status, body, { cache = 0 } = {}) {
  res.writeHead(status, { ...CORS, 'content-type': 'application/json', 'cache-control': cache ? `public, max-age=${cache}` : 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * A token bucket for one route (requests per second): plain HTTP bypasses the
 * per-link limits (limits.js), so every writing route has its own ceiling.
 * Global per route - behind a proxy every client has the same address.
 * @returns {() => void} throws a 429 when over the limit
 */
export function rateLimit(rate, burst = rate * 2, now = () => Date.now()) {
  let tokens = burst;
  let at = now();
  return () => {
    const t = now();
    tokens = Math.min(burst, tokens + ((t - at) / 1000) * rate);
    at = t;
    if (tokens < 1) throw httpError(429, 'too many requests');
    tokens -= 1;
  };
}

/** An error that becomes an HTTP status. */
export const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * Reads a request body, at most `max` bytes (413 beyond).
 * @returns {Promise<Uint8Array>}
 */
export function readBody(req, max = 1 << 20) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(httpError(413, 'too large'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => {
      const out = new Uint8Array(size);
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      resolve(out);
    });
    req.on('error', reject);
  });
}

/** @returns {Promise<any>} the JSON body (400 if malformed) */
export async function readJson(req, max = 64 * 1024) {
  const bytes = await readBody(req, max);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw httpError(400, 'bad json');
  }
}

/**
 * Envelopes in one body: u32 BE length, bytes, repeated.
 * @param {Uint8Array[]} list
 */
export function packEnvelopes(list) {
  const out = new Uint8Array(list.reduce((n, b) => n + 4 + b.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const bytes of list) {
    view.setUint32(at, bytes.length);
    out.set(bytes, at + 4);
    at += 4 + bytes.length;
  }
  return out;
}

/** @returns {Uint8Array[]|null} null if malformed */
export function unpackEnvelopes(body) {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const out = [];
  let at = 0;
  while (at < body.length) {
    if (at + 4 > body.length) return null;
    const n = view.getUint32(at);
    if (n === 0 || at + 4 + n > body.length) return null;
    out.push(body.subarray(at + 4, at + 4 + n));
    at += 4 + n;
  }
  return out;
}

/** The HTTP(S) origin of a relay url (ws:// -> http://, path and /ws dropped). */
export function httpOrigin(url) {
  const u = new URL(url);
  const protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
  return `${protocol}//${u.host}`;
}
