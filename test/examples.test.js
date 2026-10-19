/**
 * Runs every script in examples/ as its own process: the usage examples are
 * documentation, and this keeps them working as the API evolves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../examples/', import.meta.url));
const scripts = readdirSync(dir).filter((f) => /^\d\d-.*\.mjs$/.test(f)).sort();

const run = (file) =>
  new Promise((resolve) => {
    execFile(process.execPath, ['--no-warnings', file], { cwd: dir, timeout: 60_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });

test('examples/ has scripts', () => assert.ok(scripts.length >= 9));

for (const file of scripts) {
  test(`example ${file} runs to completion`, async () => {
    const { error, stdout, stderr } = await run(file);
    assert.equal(error, null, `${file} failed:\n${stderr || error?.message}`);
    assert.ok(stdout.trim().length > 0, `${file} printed nothing`);
  });
}
