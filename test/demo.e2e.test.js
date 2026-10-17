/**
 * End-to-end: the real relay (bin/mirror.mjs preset, serving the demo) and
 * separate Chromium contexts ("separate browsers"), plus real WebRTC between
 * two of them. Both tests live in this one file so they run one after the
 * other, never two browser fleets at once. Skipped without Playwright/Chromium.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMirror } from '../bin/mirror.mjs';
import { buildWeb } from '../web/build.mjs';

const demoDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
let chromium = null;
try {
  ({ chromium } = await import('playwright'));
} catch {
  chromium = null;
}

test('three browsers through the relay: invite by link and by inbox, offline, reload, removal with a new epoch', { skip: !chromium && 'playwright not installed', timeout: 120_000 }, async (t) => {
  let browser;
  // Playwright's own browser, else a preinstalled Chromium (QU_CHROMIUM or the CI image's path).
  for (const executablePath of [undefined, process.env.QU_CHROMIUM, '/opt/pw-browsers/chromium'].filter((p, i) => i === 0 || p)) {
    try {
      browser = await chromium.launch(executablePath ? { executablePath } : {});
      break;
    } catch {
      browser = null;
    }
  }
  if (!browser) return t.skip('no Chromium available');
  const dir = mkdtempSync(join(tmpdir(), 'qu-lite-e2e-'));
  await buildWeb();
  const relay = await startMirror({ port: 0, db: join(dir, 'relay.sqlite'), static: demoDir, log: () => {} });
  const base = `http://127.0.0.1:${relay.port}/`;

  try {
    const contexts = [];
    const open = async (name) => {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
      if (process.env.QU_E2E_DEBUG) page.on('console', (m) => console.log(`[${name}] ${m.text()}`));
      return page;
    };
    const errors = [];
    const step = (name) => process.env.QU_E2E_DEBUG && console.log(`# step: ${name}`);
    const ready = (page) => page.waitForSelector('body[data-ready="true"]');
    const connected = (page) => page.waitForFunction(() => document.getElementById('conn').textContent === 'verbunden');
    const chatHas = (page, text) => page.waitForFunction((t) => document.getElementById('chat').textContent.includes(t), text, { timeout: 40_000 });
    const send = async (page, text) => {
      await page.fill('#msg', text);
      await page.click('#send');
      await chatHas(page, text);
    };

    step('start page: connects to the relay that serves it and gets a test record stored');
    const start = await open('start');
    await start.goto(base);
    await ready(start);
    await connected(start);
    assert.match(await start.textContent('#snippet'), new RegExp(`${base}dist/qu-lite.js`));
    await start.click('#storeTest');
    await start.waitForFunction(() => document.getElementById('store').dataset.ok === 'true', null, { timeout: 15_000 });
    await start.close();

    step('alice founds a group, bob joins by link');
    const alice = await open('alice');
    await alice.goto(`${base}demo.html?name=alice`);
    await ready(alice);
    await connected(alice);
    await alice.click('#newGroup');
    await alice.waitForFunction(() => location.hash.startsWith('#g='));
    const sid = (await alice.evaluate(() => location.hash)).slice(3);
    await alice.click('#makeLink');
    await alice.waitForFunction(() => document.getElementById('invite').value.includes('#i='));
    const link = await alice.inputValue('#invite');

    const bob = await open('bob');
    await bob.goto(`${base}demo.html?name=bob${link.slice(link.indexOf('#'))}`);
    await ready(bob);
    await connected(bob);
    await send(alice, 'Hallo Bob');
    await chatHas(bob, 'Hallo Bob');

    step('status: online dot, read receipt, typing');
    await alice.waitForFunction(() => document.querySelectorAll('#members .dot.on').length === 2, null, { timeout: 40_000 });
    await alice.waitForFunction(() => document.getElementById('chat').textContent.includes('gelesen 1/1'), null, { timeout: 40_000 });
    await bob.type('#msg', 'tippe');
    await alice.waitForFunction(() => document.getElementById('typing').textContent.includes('tippt'), null, { timeout: 40_000 });
    await bob.fill('#msg', '');

    step('delete: alice removes her own message, it disappears at bob');
    await send(alice, 'Versehen');
    await chatHas(bob, 'Versehen');
    await alice.click('#chat li:has-text("Versehen") button.delete');
    await bob.waitForFunction(() => !document.getElementById('chat').textContent.includes('Versehen'), null, { timeout: 40_000 });

    step('shared note: both type, both see the merged text');
    await alice.type('#sharedNote', 'Einkauf: Brot');
    await bob.waitForFunction(() => document.getElementById('sharedNote').value === 'Einkauf: Brot', null, { timeout: 40_000 });
    await bob.focus('#sharedNote');
    await bob.press('#sharedNote', 'End');
    await bob.type('#sharedNote', ', Milch');
    await alice.waitForFunction(() => document.getElementById('sharedNote').value === 'Einkauf: Brot, Milch', null, { timeout: 40_000 });

    step('carol (over HTTPS + SSE) is invited by pubkey through her inbox');
    const carol = await open('carol');
    await carol.goto(`${base}demo.html?name=carol&transport=sse`); // carol is behind a "WebSocket-blocking proxy"
    await ready(carol);
    await connected(carol);
    assert.equal(await carol.textContent('#via'), 'sse');
    await alice.fill('#invitePub', await carol.textContent('#mypub'));
    await alice.click('#invitePubBtn');
    await carol.waitForSelector('#inbox button', { timeout: 40_000 });
    await carol.click('#inbox button');
    await chatHas(carol, 'Hallo Bob');

    step('bob offline, alice writes, bob back');
    await bob.click('#toggle');
    await bob.waitForFunction(() => document.getElementById('conn').textContent === 'getrennt');
    await send(alice, 'waehrend Bob offline war');
    await bob.click('#toggle');
    await connected(bob);
    await chatHas(bob, 'waehrend Bob offline war');

    step('alice writes offline and reloads before reconnecting');
    await alice.click('#toggle');
    await alice.waitForFunction(() => document.getElementById('conn').textContent === 'getrennt');
    await send(alice, 'vor dem Reload geschrieben');
    await alice.waitForFunction(() => Number(document.getElementById('outbox').textContent) > 0);
    await alice.goto(`${base}demo.html?name=alice&offline#g=${sid}`);
    await ready(alice);
    await chatHas(alice, 'vor dem Reload geschrieben');
    await alice.waitForFunction(() => Number(document.getElementById('outbox').textContent) > 0);
    await alice.click('#toggle');
    await connected(alice);
    await chatHas(bob, 'vor dem Reload geschrieben');
    await chatHas(carol, 'vor dem Reload geschrieben');
    await alice.waitForFunction(() => document.getElementById('outbox').textContent === '0');

    step('alice removes bob: new epoch, carol keeps reading, bob is locked out');
    const bobAlias = await bob.evaluate(async (s) => (await globalThis.qu.members(globalThis.qu.space(s))).me, sid);
    await alice.waitForFunction((a) => [...document.querySelectorAll('#members li')].some((li) => li.textContent.includes(a.slice(0, 8))), bobAlias);
    await alice.evaluate((a) => [...document.querySelectorAll('#members li')].find((li) => li.textContent.includes(a.slice(0, 8))).querySelector('button').click(), bobAlias);
    await alice.waitForFunction(() => document.getElementById('epoch').textContent === 'Epoche 1');
    await carol.waitForFunction(() => document.getElementById('epoch').textContent === 'Epoche 1', null, { timeout: 40_000 });
    await send(alice, 'nach dem Entfernen');
    await chatHas(carol, 'nach dem Entfernen');
    await bob.waitForFunction(() => document.getElementById('banner').textContent.includes('entfernt'), null, { timeout: 40_000 });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await bob.textContent('#chat')).includes('nach dem Entfernen'), false);

    step('event log, relay contents, no page errors');
    // The log shows only its newest 300 lines, so look each topic up through the log's own filter.
    for (const topic of ['net.peer.up', 'sync.done', 'qu.members.epoch', 'qu.signal.']) {
      await alice.fill('#filter', topic);
      assert.ok((await alice.textContent('#log')).includes(topic), `event log shows ${topic}`);
    }
    for (const key of await relay.qu.storage.keys('rec/')) {
      assert.equal(Buffer.from(await relay.qu.storage.get(key)).includes('Hallo Bob'), false);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two browsers connect directly (WebRTC) and keep chatting when the relay goes down', { skip: !chromium && 'playwright not installed', timeout: 120_000 }, async (t) => {
  // Local test: let Chromium use plain host candidates instead of mDNS names.
  const args = ['--disable-features=WebRtcHideLocalIpsWithMdns'];
  let browser = null;
  for (const executablePath of [undefined, process.env.QU_CHROMIUM, '/opt/pw-browsers/chromium'].filter((p, i) => i === 0 || p)) {
    try {
      browser = await chromium.launch(executablePath ? { executablePath, args } : { args });
      break;
    } catch {}
  }
  if (!browser) return t.skip('no Chromium available');
  const dir = mkdtempSync(join(tmpdir(), 'qu-lite-rtc-'));
  await buildWeb();
  const relay = await startMirror({ port: 0, db: join(dir, 'relay.sqlite'), static: demoDir, log: () => {} });
  const base = `http://127.0.0.1:${relay.port}/`;
  const errors = [];
  try {
    const open = async (name) => {
      const page = await (await browser.newContext()).newPage();
      page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
      return page;
    };
    const ready = (page) => page.waitForSelector('body[data-ready="true"]');
    const chatHas = (page, text) => page.waitForFunction((x) => document.getElementById('chat').textContent.includes(x), text, { timeout: 40_000 });

    const alice = await open('alice');
    await alice.goto(`${base}demo.html?name=alice`);
    await ready(alice);
    await alice.waitForFunction(() => document.getElementById('conn').textContent === 'verbunden');
    await alice.click('#newGroup');
    await alice.waitForFunction(() => location.hash.startsWith('#g='));
    await alice.click('#makeLink');
    await alice.waitForFunction(() => document.getElementById('invite').value.includes('#i='));
    const link = await alice.inputValue('#invite');
    const bob = await open('bob');
    await bob.goto(`${base}demo.html?name=bob${link.slice(link.indexOf('#'))}`);
    await ready(bob);

    for (const page of [alice, bob]) await page.waitForFunction(() => document.getElementById('direct').textContent === '1', null, { timeout: 40_000 });

    await relay.close(); // the relay is gone; only the direct link remains
    for (const page of [alice, bob]) await page.waitForFunction(() => document.getElementById('conn').textContent !== 'verbunden', null, { timeout: 40_000 });
    await alice.fill('#msg', 'ohne Relay');
    await alice.click('#send');
    await chatHas(bob, 'ohne Relay');

    // relay-only closes the direct link
    await bob.selectOption('#rtcMode', 'relay-only');
    for (const page of [alice, bob]) await page.waitForFunction(() => document.getElementById('direct').textContent === '0', null, { timeout: 40_000 });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await relay.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
