import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../src/node.js';

test('your app at /: app folder first, the relay\'s files after it, start page as /qu.html, optional SPA fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qu-static-'));
  const app = join(dir, 'app');
  const web = join(dir, 'web');
  mkdirSync(app);
  mkdirSync(join(web, 'dist'), { recursive: true });
  writeFileSync(join(app, 'index.html'), 'MY APP');
  writeFileSync(join(app, 'app.js'), 'app()');
  writeFileSync(join(web, 'index.html'), 'START PAGE');
  writeFileSync(join(web, 'demo.html'), 'DEMO');
  writeFileSync(join(web, 'dist', 'qu-client.js'), 'LIB');
  writeFileSync(join(dir, 'secret.txt'), 'SECRET');
  const get = async (relay, path) => {
    const res = await fetch(`http://127.0.0.1:${relay.port}${path}`);
    return `${res.status} ${await res.text()}`;
  };
  const plain = await createRelay({ port: 0, static: web, log: () => {} });
  assert.equal(await get(plain, '/'), '200 START PAGE', 'without an app: the start page at /');
  await plain.close();

  const relay = await createRelay({ port: 0, static: web, app, log: () => {} });
  assert.equal(await get(relay, '/'), '200 MY APP');
  assert.equal(await get(relay, '/app.js'), '200 app()');
  assert.equal(await get(relay, '/dist/qu-client.js'), '200 LIB', 'the library still comes from the relay');
  assert.equal(await get(relay, '/demo.html'), '200 DEMO');
  assert.equal(await get(relay, '/qu.html'), '200 START PAGE', 'the start page moved');
  assert.equal(await get(relay, '/chat/42'), '404 not found', 'no SPA fallback unless asked');
  assert.equal(await get(relay, '/../secret.txt'), '404 not found');
  assert.equal(await get(relay, '/%2e%2e/secret.txt'), '404 not found', 'never outside the folders');
  assert.equal(await get(relay, '/healthz'), '200 ok');
  await relay.close();

  const spa = await createRelay({ port: 0, static: web, app, spa: true, log: () => {} });
  assert.equal(await get(spa, '/chat/42'), '200 MY APP', 'client-side routes get the app');
  assert.equal(await get(spa, '/missing.js'), '404 not found', 'files stay 404');
  await spa.close();
  rmSync(dir, { recursive: true, force: true });
});
