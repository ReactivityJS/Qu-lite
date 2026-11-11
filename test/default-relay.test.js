import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, httpOrigin, publicLink } from '../src/index.js';

test('httpOrigin keeps a proxy prefix and drops /ws, /sse, a page and slashes', () => {
  assert.equal(httpOrigin('wss://example.org/qu/ws'), 'https://example.org/qu');
  assert.equal(httpOrigin('https://example.org/qu/'), 'https://example.org/qu');
  assert.equal(httpOrigin('http://localhost:8787/demo.html'), 'http://localhost:8787');
  assert.equal(httpOrigin('ws://127.0.0.1:8787/sse'), 'http://127.0.0.1:8787');
  assert.equal(publicLink('https://example.org/qu/', 'a'.repeat(32), 'blog'), `https://example.org/qu/q/${'a'.repeat(32)}/blog`);
});

test('createClient in a browser page uses the address the page came from; url: null means none', async () => {
  const saved = globalThis.location;
  try {
    globalThis.location = new URL('https://example.org/qu/index.html');
    const qu = await createClient({ devtools: false, transports: undefined, relay: { minDelayMs: 60_000 } });
    assert.deepEqual(qu.transports.relay.urls, ['https://example.org/qu/']);
    qu.transports.relay.disconnect();
    await qu.close();
    const local = await createClient({ devtools: false, url: null });
    assert.equal(local.transports?.relay, undefined, 'no relay');
    await local.close();
  } finally {
    if (saved === undefined) delete globalThis.location;
    else globalThis.location = saved;
  }
});
