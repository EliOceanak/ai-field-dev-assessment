#!/usr/bin/env node
/**
 * `npm run inspect-db` — pretty-print the on-disk limiter state.
 *
 * ```bash
 * node scripts/inspect-db.mjs [path]     # default: ./data/router.db
 * ```
 */
import { resolve } from 'node:path';
import { inspectDatabase, sqlite3Dump } from './lib/inspect.mjs';

const path = resolve(process.argv[2] ?? resolve(import.meta.dirname, '..', 'data', 'router.db'));
const report = inspectDatabase(path);

console.log(`Task 4 — SQLite inspection: ${report.path}`);
console.log('='.repeat(72));
console.log(report.sections.join('\n'));

if (report.ok) {
  const dump = sqlite3Dump(path, 'SELECT tenant_id, kind, tokens FROM token_events ORDER BY id;');
  console.log('');
  console.log('$ sqlite3 ' + path + " 'SELECT tenant_id, kind, tokens FROM token_events ORDER BY id;'");
  console.log(dump === null ? '  (sqlite3 CLI not available — the tables above are the same rows)' : dump);
} else {
  console.log('');
  console.log('Run `npm run demo` first: it writes ./data/router.db.');
  process.exitCode = 1;
}
