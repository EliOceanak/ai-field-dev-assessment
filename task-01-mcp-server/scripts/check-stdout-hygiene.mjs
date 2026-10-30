#!/usr/bin/env node
/**
 * Static guard for the stdio-isolation rule.
 *
 * "The server MUST NOT write anything to its stdout that is not a valid MCP
 *  message."  (MCP spec, stdio transport binding)
 *
 * A single `console.log` in this package corrupts the JSON-RPC framing on the
 * wire, so the rule is enforced twice: statically here (fails `npm test`), and
 * on the wire in `tests/wire/stdout-isolation.test.ts` (parses every byte the
 * real process writes to stdout).
 *
 * Only `src/` is scanned: `scripts/` contains CLIs whose whole job is to print
 * transcripts to stdout.
 *
 * Allowed (all write to stderr): console.error, console.warn, console.trace.
 * Escape hatch: put `stdout-guard: allow` in the offending line or the line above.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const SCAN_DIRS = ['src'];
const SCAN_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const ALLOW_MARKER = 'stdout-guard: allow';

const FORBIDDEN = [
  { regex: /\bconsole\.log\s*\(/, hint: 'use logger.info(event, fields) — it writes to stderr' },
  { regex: /\bconsole\.info\s*\(/, hint: 'use logger.info(event, fields) — it writes to stderr' },
  { regex: /\bconsole\.debug\s*\(/, hint: 'use logger.debug(event, fields) — it writes to stderr' },
  { regex: /\bconsole\.dir\s*\(/, hint: 'use logger.debug(event, fields) instead' },
  { regex: /\bconsole\.table\s*\(/, hint: 'use logger.debug(event, fields) instead' },
  { regex: /\bprocess\.stdout\b/, hint: 'stdout is reserved for JSON-RPC frames' }
];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      yield* walk(full);
    } else if (SCAN_EXTENSIONS.has(extname(entry.name))) {
      yield full;
    }
  }
}

const violations = [];
let scanned = 0;

for (const scanDir of SCAN_DIRS) {
  const absolute = join(PACKAGE_ROOT, scanDir);
  let files;
  try {
    files = [...walk(absolute)];
  } catch {
    continue; // directory not created yet
  }

  for (const file of files) {
    scanned += 1;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.includes(ALLOW_MARKER) || (lines[index - 1] ?? '').includes(ALLOW_MARKER)) return;
      for (const { regex, hint } of FORBIDDEN) {
        if (regex.test(line)) {
          violations.push({
            file: relative(PACKAGE_ROOT, file),
            line: index + 1,
            code: line.trim(),
            hint
          });
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error(`stdout hygiene: ${violations.length} violation(s) — stdout must stay pure JSON-RPC\n`);
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line}`);
    console.error(`    ${violation.code}`);
    console.error(`    ↳ ${violation.hint}\n`);
  }
  console.error('Log through src/logging/logger.ts (stderr) or add `stdout-guard: allow` if intentional.');
  process.exit(1);
}

console.log(`stdout hygiene: OK (${scanned} file(s) scanned in ${SCAN_DIRS.join(', ')})`);
