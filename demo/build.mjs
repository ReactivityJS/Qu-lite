/**
 * Bundles the browser demo (app.js + @qu/lite's browser-safe barrel) into
 * dist/app.js. `platform: 'browser'` makes esbuild refuse Node-only imports
 * (node:sqlite, ws) instead of silently shipping them.
 *
 *   node demo/build.mjs
 */
import * as esbuild from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export async function buildDemo() {
  await esbuild.build({
    entryPoints: [join(here, 'app.js')],
    outfile: join(here, 'dist', 'app.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    sourcemap: true,
    logLevel: 'warning',
  });
  return join(here, 'dist', 'app.js');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`built ${await buildDemo()}`);
}
