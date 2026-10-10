/**
 * End-to-end: the real relay (bin/mirror.mjs preset, serving the demo) and
 * two separate Chromium contexts ("two browsers"). Skipped if Playwright or
 * its browser is not available.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMirror } from '../bin/mirror.mjs';
import { buildDemo } from '../demo/build.mjs';

const demoDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'demo');
let chromium = null;
try {
  ({ chromium } = await import('playwright'));
} catch {
  chromium = null;
}

test('two browsers sync through the relay: live, offline, reload with a pending write, user node', { skip: !chromium && 'playwright not installed', timeout: 120_000 }, async (t) => {
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
  await buildDemo();
  const relay = await startMirror({ port: 0, db: join(dir, 'relay.sqlite'), static: demoDir, log: () => {} });
  const base = `http://127.0.0.1:${relay.port}/`;

  try {
    const alice = await (await browser.newContext()).newPage();
    const bob = await (await browser.newContext()).newPage();
    const errors = [];
    for (const page of [alice, bob]) {
      page.on('pageerror', (e) => errors.push(e.message));
      if (process.env.QU_E2E_DEBUG) page.on('console', (m) => console.log(`[${page === alice ? 'alice' : 'bob'}] ${m.text()}`));
    }
    const step = (name) => process.env.QU_E2E_DEBUG && console.log(`# step: ${name}`);
    const connected = (page) => page.waitForFunction(() => document.getElementById('conn').textContent === 'verbunden');
    const chatHas = (page, text) => page.waitForFunction((t) => document.getElementById('chat').textContent.includes(t), text, { timeout: 15_000 });

    await alice.goto(`${base}?name=alice`);
    await alice.waitForSelector('body[data-ready="true"]');
    await connected(alice);
    await alice.click('#newGroup');
    await alice.waitForFunction(() => document.getElementById('invite').value.includes('#s='));
    const invite = await alice.inputValue('#invite');
    const secret = invite.split('#s=')[1];

    await bob.goto(`${base}?name=bob#s=${secret}`);
    await bob.waitForSelector('body[data-ready="true"]');
    await connected(bob);

    step('live');
    // live
    await alice.fill('#msg', 'Hallo Bob');
    await alice.click('#send');
    await chatHas(bob, 'Hallo Bob');

    step('bob offline');
    // Bob offline, Alice writes, Bob back
    await bob.click('#toggle');
    await bob.waitForFunction(() => document.getElementById('conn').textContent === 'getrennt');
    await alice.fill('#msg', 'waehrend Bob offline war');
    await alice.click('#send');
    await bob.click('#toggle');
    await connected(bob);
    await chatHas(bob, 'waehrend Bob offline war');

    step('alice reload');
    // Alice offline, writes, reloads (still offline): the write waits in IndexedDB; then reconnects
    await alice.click('#toggle');
    await alice.waitForFunction(() => document.getElementById('conn').textContent === 'getrennt');
    await alice.fill('#msg', 'vor dem Reload geschrieben');
    await alice.click('#send');
    await chatHas(alice, 'vor dem Reload geschrieben'); // stored in IndexedDB before we navigate away
    await alice.waitForFunction(() => Number(document.getElementById('outbox').textContent) > 0);
    await alice.goto(`${base}?name=alice&offline#s=${secret}`);
    await alice.waitForSelector('body[data-ready="true"]');
    await chatHas(alice, 'vor dem Reload geschrieben');
    await alice.waitForFunction(() => Number(document.getElementById('outbox').textContent) > 0); // survived the reload
    step('alice reconnects');
    await alice.click('#toggle');
    await connected(alice);
    step('bob receives the pending write');
    try {
      await chatHas(bob, 'vor dem Reload geschrieben');
    } catch (error) {
      if (process.env.QU_E2E_DEBUG) {
        for (const page of [alice, bob]) console.log((await page.textContent('#log')).split('\n').filter((l) => !/net\.(in|out)\.\w+\.(neg|negr|ack)/.test(l)).slice(-40).join('\n'));
        console.log('relay rec count', (await relay.qu.storage.keys('rec/')).length);
      }
      throw error;
    }
    step('alice outbox drains');
    await alice.waitForFunction(() => document.getElementById('outbox').textContent === '0');

    step('user node');
    // user node: Bob publishes a name, Alice looks him up by pubkey
    await bob.fill('#name', 'Bob B.');
    await bob.click('#saveName');
    const bobPub = await bob.textContent('#mypub');
    await alice.fill('#lookup', bobPub);
    await alice.click('#doLookup');
    await alice.waitForFunction(() => document.getElementById('lookupResult').textContent.includes('Bob B.'), null, { timeout: 15_000 });

    step('log');
    // the event log shows the network and the sync at work
    const log = await alice.textContent('#log');
    assert.ok(log.includes('net.peer.up'));
    assert.ok(log.includes('sync.done'));

    // the relay holds only sealed envelopes
    const stored = await relay.qu.storage.keys('');
    assert.ok(stored.some((k) => k.startsWith('rec/')));
    for (const key of stored) {
      const value = await relay.qu.storage.get(key);
      if (value instanceof Uint8Array) assert.equal(Buffer.from(value).includes('Hallo Bob'), false);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
