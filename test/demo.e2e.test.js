/**
 * End-to-end: the real relay (bin/mirror.mjs preset, serving the demo) and
 * separate Chromium contexts ("separate browsers"), plus real WebRTC between
 * two of them. Both tests live in this one file so they run one after the
 * other, never two browser fleets at once. Skipped without Playwright/Chromium.
 * How to run and debug them: docs/TESTING.md.
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
// QU_E2E_HEADED=1 shows the browsers, QU_E2E_SLOWMO=<ms> slows every action down (debugging; docs/TESTING.md)
const visible = process.env.QU_E2E_HEADED ? { headless: false, slowMo: Number(process.env.QU_E2E_SLOWMO ?? 0) } : {};
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
      browser = await chromium.launch({ ...visible, ...(executablePath ? { executablePath } : {}) });
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
    assert.match(await start.textContent('#snippet'), new RegExp(`${base}dist/qu-client.js`));
    // the snippet works as shown: small entry, plugins as chunks from the relay, devtools on window.qu
    const roundTrip = await start.evaluate(async (origin) => {
      const { createClient } = await import(`${origin}dist/qu-client.js`);
      const qu = await createClient({ url: origin.replace(/\/$/, ''), name: `snippet-${Date.now()}`, devtools: { log: () => {}, global: 'snippetQu' } });
      const group = await qu.createGroup();
      await qu.write(group, 'chat', 'hallo');
      for (let i = 0; i < 200 && (await qu.syncStatus()).outbox; i++) await new Promise((r) => setTimeout(r, 50));
      const status = await qu.device.status();
      const t0 = performance.now();
      const backup = await qu.device.exportBackup('correct horse battery staple');
      const backupMs = performance.now() - t0;
      const result = {
        outbox: (await qu.syncStatus()).outbox,
        global: globalThis.snippetQu === qu,
        plugins: qu.dev.info().plugins,
        persistedKnown: typeof status.persisted === 'boolean',
        quota: status.quota > 0,
        backup: backup.startsWith('qu-backup.'),
        backupAt: (await qu.device.status()).backupAt > 0,
        backupMs,
      };
      await qu.close();
      return result;
    }, base);
    assert.equal(roundTrip.outbox, 0, 'acked by the relay');
    assert.ok(roundTrip.global && roundTrip.plugins.includes('devtools'));
    // device plugin in a real browser: storage status from navigator.storage, a full-strength backup
    assert.ok(roundTrip.persistedKnown && roundTrip.quota, 'navigator.storage answers');
    assert.ok(roundTrip.backup && roundTrip.backupAt, 'backup exported and remembered');
    t.diagnostic(`backup with 600k PBKDF2 rounds in Chromium: ${roundTrip.backupMs.toFixed(0)} ms`);
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
      browser = await chromium.launch({ ...visible, args, ...(executablePath ? { executablePath } : {}) });
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

test('the two-console walkthrough of docs/CONSOLE.md runs as written, in two browsers', { skip: !chromium && 'playwright not installed', timeout: 120_000 }, async (t) => {
  let browser;
  for (const executablePath of [undefined, process.env.QU_CHROMIUM, '/opt/pw-browsers/chromium'].filter((p, i) => i === 0 || p)) {
    try {
      browser = await chromium.launch({ ...visible, ...(executablePath ? { executablePath } : {}) });
      break;
    } catch {
      browser = null;
    }
  }
  if (!browser) return t.skip('no Chromium available');
  const { readFileSync } = await import('node:fs');
  // the ```js konsole-a / konsole-b blocks of the walkthrough, in document order
  const doc = readFileSync(join(demoDir, '..', 'docs', 'CONSOLE.md'), 'utf8');
  const blocks = [...doc.matchAll(/```js ((?:konsole-[ab] ?)+)\n([\s\S]*?)```/g)].map(([, who, code]) => ({ who: who.trim().split(' '), code }));
  assert.ok(blocks.length >= 7, 'walkthrough found');
  const dir = mkdtempSync(join(tmpdir(), 'qu-lite-e2e-'));
  await buildWeb();
  const relay = await startMirror({ port: 0, db: join(dir, 'relay.sqlite'), static: demoDir, log: () => {} });
  const base = `http://127.0.0.1:${relay.port}/`;
  try {
    const pages = {};
    let clipboard = null;
    for (const who of ['konsole-a', 'konsole-b']) {
      const page = await (await browser.newContext()).newPage();
      page.on('dialog', (d) => d.accept(clipboard)); // prompt('Einladung einfügen') gets what copy() took
      page.on('pageerror', (e) => console.log(`[${who}]`, e.message));
      await page.goto(base);
      await page.exposeFunction('copy', (text) => (clipboard = text)); // the DevTools console's copy()
      pages[who] = page;
    }
    // each block like pasted into the console: statements in order, the last expression's value returned
    const run = async (page, code) => {
      const lines = code.trim().split('\n');
      const last = lines.pop();
      return page.evaluate(`(async () => {\n${lines.join('\n')}\nreturn ${last.replace(/;\s*(\/\/.*)?$/, '')};\n})()`);
    };
    const until = async (page, check, what, ms = 15_000) => {
      for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (await page.evaluate(check)) return;
      const diag = async (p) => p.evaluate(async () => ({ sync: await qu.syncStatus(), defer: (await qu.storage.keys('defer/')).length, out: await qu.storage.keys('sync/out/'), links: qu.dev.links().length, chat: (await qu.query({ space: g, path: 'chat' })).length, members: (await qu.members(g)).list().map((m) => m.role) }));
      console.log('DIAG A', JSON.stringify(await diag(pages['konsole-a'])), 'B', JSON.stringify(await diag(pages['konsole-b'])));
      throw new Error(`timed out: ${what}`);
    };
    const results = [];
    for (const [n, block] of blocks.entries()) {
      for (const who of block.who) results.push({ n, who, value: await run(pages[who], block.code) });
      // let the other side catch up where the next block reads what this one wrote
      if (n === 1) await until(pages['konsole-a'], `(async () => (await qu.query({ space: g, path: 'chat' })).length >= 1)()`, 'A has B\'s message');
      if (n === 2) await until(pages['konsole-b'], `(async () => (await qu.query({ space: g, path: 'chat' })).length >= 3 && (await qu.blobs.has(g, (await qu.query({ space: g, path: 'chat' })).at(-1).value.file)).complete)()`, 'B has the file');
      if (n === 4) {
        await new Promise((r) => setTimeout(r, 300));
        for (const page of Object.values(pages)) await until(page, `[...st.online().values()].some((e) => e.online)`, 'presence');
      }
      if (n === 5) await until(pages['konsole-a'], `(async () => (await qu.query({ space: g, path: 'chat' })).length === 4)()`, 'offline message delivered');
    }
    const at = (n, who) => results.find((r) => r.n === n && r.who === who).value;
    assert.equal(at(3, 'konsole-b'), 'Inhalt der Notiz', 'B got the file');
    assert.deepEqual(await run(pages['konsole-a'], "(await qu.query({ space: g, path: 'chat' })).map((r) => r.value.text)"), ['Hallo von B', 'Hallo zurück', 'Datei anbei', 'offline geschrieben']);
    assert.deepEqual(await run(pages['konsole-b'], "(await qu.query({ space: g, path: 'events', where: { start: { gte: Date.parse('2026-11-01') } } })).map((r) => r.value.title)"), ['Treffen']);
  } finally {
    await browser.close();
    await relay.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a security key (virtual, with PRF) registers on one device and unlocks the identity on another', { skip: !chromium && 'playwright not installed', timeout: 120_000 }, async (t) => {
  let browser;
  for (const executablePath of [undefined, process.env.QU_CHROMIUM, '/opt/pw-browsers/chromium'].filter((p, i) => i === 0 || p)) {
    try {
      browser = await chromium.launch({ ...visible, ...(executablePath ? { executablePath } : {}) });
      break;
    } catch {
      browser = null;
    }
  }
  if (!browser) return t.skip('no Chromium available');
  const dir = mkdtempSync(join(tmpdir(), 'qu-lite-e2e-'));
  await buildWeb();
  const relay = await startMirror({ port: 0, db: join(dir, 'relay.sqlite'), static: demoDir, log: () => {} });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`http://localhost:${relay.port}/`); // WebAuthn needs a domain: localhost, not 127.0.0.1
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
    });
    // two "devices" = two databases in one browser; the virtual key is the same YubiKey for both
    const result = await page.evaluate(async () => {
      const { createClient } = await import('/dist/qu-client.js');
      const pc = await createClient({ url: location.origin, name: 'device-pc', devtools: false });
      const group = await pc.createGroup();
      await pc.write(group, 'chat', 'from the PC');
      const added = await pc.device.addKey({ name: 'YubiKey', kind: 'security-key' });
      const phone = await createClient({ url: location.origin, name: 'device-phone', devtools: false, unlock: 'key' });
      const [space] = await phone.restoreGroups();
      for (let i = 0; i < 200 && !(await phone.query({ space, path: 'chat' })).length; i++) await new Promise((r) => setTimeout(r, 50));
      const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      const [key] = await pc.device.keys();
      return { synced: added.synced, same: hex(phone.identity.publicKey) === hex(pc.identity.publicKey), chat: (await phone.query({ space, path: 'chat' })).map((r) => r.value), key: { name: key.name, type: key.type, transports: key.transports } };
    });
    // the browser tells what answered: a security key over USB (the virtual one)
    assert.deepEqual(result, { synced: true, same: true, chat: ['from the PC'], key: { name: 'YubiKey', type: 'security-key', transports: ['usb'] } });
    const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    assert.equal(credentials.length, 1);
    assert.equal(credentials[0].isResidentCredential, true, 'discoverable: unlock needs no user name');
  } finally {
    await browser.close();
    await relay.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
