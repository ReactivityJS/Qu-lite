/**
 * Builds what the relay serves next to its API (web/, `--static web`):
 *
 *   dist/qu-lite.js   the browser-safe library as ONE ES module - apps (and
 *                     the start page, index.html) import it from the relay:
 *                     `import { createPeer } from 'https://relay.example/dist/qu-lite.js'`
 *   dist/demo.js      the demo app (demo.html), bundled with the library
 *
 * `platform: 'browser'` makes esbuild refuse Node-only imports (node:sqlite,
 * ws) instead of silently shipping them.
 *
 *   node web/build.mjs
 */
import * as esbuild from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export async function buildWeb() {
  const common = { bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, sourcemap: true, logLevel: 'warning' };
  await esbuild.build({ ...common, entryPoints: [join(here, '..', 'src', 'index.js')], outfile: join(here, 'dist', 'qu-lite.js') });
  await esbuild.build({ ...common, entryPoints: [join(here, 'demo.js')], outfile: join(here, 'dist', 'demo.js') });
  return join(here, 'dist');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`built ${await buildWeb()}`);
}
