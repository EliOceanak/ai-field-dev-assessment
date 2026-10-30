#!/usr/bin/env node
/**
 * Logging-hygiene guard (repo convention: structured JSON logs to stderr only).
 *
 * stdout stays clean so that every task's stdout is either protocol bytes (Task 1)
 * or the proxied payload (Tasks 2-4) — never a stray diagnostic. Scans `src/` only:
 * `scripts/` and `mock/` contain CLIs that deliberately print to stdout.
 *
 * Escape hatch: put `stdout-guard: allow` in the offending line or the line above.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const SCAN_DIRS = ['src'];
const SCAN_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const ALLOW_MARKER = 'stdout-guard: allow';

const FORBIDDEN = [
  { regex: /\bconsole\.log\s*\(/, hint: 'use logger.info(event, fields) — it writes JSON to stderr' },
  { regex: /\bconsole\.info\s*\(/, hint: 'use logger.info(event, fields) — it writes JSON to stderr' },
  { regex: /\bconsole\.debug\s*\(/, hint: 'use logger.debug(event, fields) — it writes JSON to stderr' },
  { regex: /\bprocess\.stdout\b/, hint: 'stdout is reserved for the proxied payload' }
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
  let files;
  try {
    files = [...walk(join(PACKAGE_ROOT, scanDir))];
  } catch {
    continue;
  }

  for (const file of files) {
    scanned += 1;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.includes(ALLOW_MARKER) || (lines[index - 1] ?? '').includes(ALLOW_MARKER)) return;
      for (const { regex, hint } of FORBIDDEN) {
        if (regex.test(line)) {
          violations.push({ file: relative(PACKAGE_ROOT, file), line: index + 1, code: line.trim(), hint });
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error(`logging hygiene: ${violations.length} violation(s)\n`);
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line}`);
    console.error(`    ${violation.code}`);
    console.error(`    ↳ ${violation.hint}\n`);
  }
  process.exit(1);
}

console.log(`logging hygiene: OK (${scanned} file(s) scanned in ${SCAN_DIRS.join(', ')})`);
