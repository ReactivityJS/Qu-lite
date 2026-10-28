#!/usr/bin/env node
/**
 * Online backup of a relay's SQLite database - safe while the relay keeps
 * running (SQLite's backup API, consistent even with WAL), no sqlite3 tool
 * needed (the Docker image has none).
 *
 *   node --no-warnings bin/backup.mjs [source] [target]
 *     source  default $QU_DB or ./mirror.sqlite
 *     target  default <source dir>/backup-<UTC timestamp>.sqlite
 *
 * Docker: docker compose exec qu-lite node --no-warnings bin/backup.mjs
 * Restore: stop the relay, replace the database file with the backup
 * (and remove a leftover `-wal`/`-shm` next to it), start again.
 */
import { DatabaseSync, backup } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @returns {Promise<string>} the backup's path */
export async function backupDatabase(source, target) {
  if (!existsSync(source)) throw new Error(`backup: no database at ${source}`);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z');
  const out = target ?? join(dirname(resolve(source)), `backup-${stamp}.sqlite`);
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, out);
  } finally {
    db.close();
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [source = process.env.QU_DB ?? './mirror.sqlite', target] = process.argv.slice(2);
  try {
    const out = await backupDatabase(source, target);
    console.log(`backup written: ${out} (${statSync(out).size} bytes)`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
