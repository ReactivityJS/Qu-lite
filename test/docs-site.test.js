import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocs } from '../web/build-docs.mjs';
import { createRelay } from '../src/node.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the documentation builds to HTML and every link between the pages hits an existing anchor', async () => {
  const out = mkdtempSync(join(tmpdir(), 'qu-docs-'));
  const pages = await buildDocs({ to: out });
  assert.ok(pages >= 10);
  const html = Object.fromEntries(readdirSync(out).filter((f) => f.endsWith('.html')).map((f) => [f, readFileSync(join(out, f), 'utf8')]));
  const ids = Object.fromEntries(Object.entries(html).map(([f, h]) => [f, new Set([...h.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))]));
  const broken = [];
  for (const [file, h] of Object.entries(html)) {
    for (const [, href] of h.matchAll(/ href="([^"]+)"/g)) {
      if (/^(https?:|\.\.\/|mailto:)/.test(href) || href === 'docs.css') continue;
      const [page, anchor] = href.split('#');
      const target = page || file;
      if (!html[target]) broken.push(`${file}: ${href} (no page)`);
      else if (anchor && !ids[target].has(decodeURIComponent(anchor))) broken.push(`${file}: ${href} (no anchor)`);
    }
  }
  assert.deepEqual(broken, [], 'broken links');
  assert.match(html['BENUTZER.html'], /YubiKey/);
  assert.match(html['index.html'], /class="active"/);
  rmSync(out, { recursive: true, force: true });
});

test('the relay serves /docs/ only when asked', async () => {
  const out = mkdtempSync(join(tmpdir(), 'qu-docs-'));
  await buildDocs({ to: out });
  const off = await createRelay({ port: 0, static: join(root, 'web'), log: () => {} });
  assert.equal((await fetch(`http://127.0.0.1:${off.port}/docs/`)).status, 404);
  assert.equal((await (await fetch(`http://127.0.0.1:${off.port}/info`)).json()).docs, undefined);
  await off.close();
  const on = await createRelay({ port: 0, static: join(root, 'web'), docs: out, log: () => {} });
  const base = `http://127.0.0.1:${on.port}`;
  assert.match(await (await fetch(`${base}/docs/`)).text(), /Wer liest was/);
  assert.match(await (await fetch(`${base}/docs/BENUTZER.html`)).text(), /Mit YubiKey oder Passkey schützen/);
  assert.equal((await fetch(`${base}/docs`, { redirect: 'manual' })).status, 301);
  assert.equal((await fetch(`${base}/docs/../package.json`)).status, 404);
  assert.equal((await (await fetch(`${base}/info`)).json()).docs, '/docs/');
  assert.equal((await fetch(`${base}/qu.html`)).status, 200, 'the start page is also /qu.html');
  await on.close();
  rmSync(out, { recursive: true, force: true });
});
