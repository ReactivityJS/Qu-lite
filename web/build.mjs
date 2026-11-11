/**
 * Builds what the relay serves next to its API (web/, `--static web`):
 *
 *   dist/qu-lite.js   the browser-safe library as ONE ES module - apps (and
 *                     the start page, index.html) import it from the relay:
 *                     `import { createPeer } from 'https://relay.example/dist/qu-lite.js'`
 *   dist/qu-client.js the small entry (createClient/createPeer + kernel); every
 *                     plugin, store and transport is its own chunk in dist/chunks/,
 *                     fetched only when a peer uses it
 *   dist/demo.js      the demo app (demo.html), bundled with the library
 *   ../docs-site/     the documentation as HTML (build-docs.mjs) - served at /docs/ only
 *                     with `--docs` / QU_DOCS=1
 *   dist/qu-sw.js     service worker helper (classic script): `importScripts(...)`, then
 *                     `quServiceWorker({...})` - Background Sync and push (sw.js)
 *
 * `platform: 'browser'` makes esbuild refuse Node-only imports (node:sqlite,
 * ws) instead of silently shipping them.
 *
 *   node web/build.mjs
 */
import * as esbuild from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { buildDocs } from './build-docs.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export async function buildWeb() {
  const common = { bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, sourcemap: true, logLevel: 'warning' };
  await esbuild.build({ ...common, entryPoints: [join(here, '..', 'src', 'index.js')], outfile: join(here, 'dist', 'qu-lite.js') });
  rmSync(join(here, 'dist', 'chunks'), { recursive: true, force: true }); // hashed names: drop chunks of earlier builds
  await esbuild.build({ ...common, entryPoints: { 'qu-client': join(here, '..', 'src', 'browser.js') }, outdir: join(here, 'dist'), splitting: true, chunkNames: 'chunks/[name]-[hash]' });
  await esbuild.build({ ...common, entryPoints: [join(here, 'demo.js')], outfile: join(here, 'dist', 'demo.js') });
  // service worker helper as a CLASSIC script (importScripts works in every browser's worker): self.quServiceWorker
  await esbuild.build({ ...common, format: 'iife', globalName: 'quSw', footer: { js: 'self.quServiceWorker = quSw.quServiceWorker;' }, entryPoints: [join(here, '..', 'src', 'sw.js')], outfile: join(here, 'dist', 'qu-sw.js') });
  await buildDocs();
  return join(here, 'dist');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`built ${await buildWeb()}`);
}
