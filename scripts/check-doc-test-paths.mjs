#!/usr/bin/env node
/**
 * Doc/evidence consistency check.
 *
 * The root README, `docs/GRADER-GUIDE.md` and `docs/VERIFICATION.md` claim that
 * specific test files prove specific rubric bullets. Docs drift silently, so this
 * script extracts every `src/…`, `tests/…`, `scripts/…`, `mock/…` or `config/…`
 * path mentioned in those files and asserts it exists.
 *
 * Two accepted forms:
 *   - `task-03-streaming-guardrail/tests/unit/patterns.test.ts`  → resolved from the repo root
 *   - `tests/unit/patterns.test.ts`                              → repo root, or any task folder
 *
 * A non-prefixed path may legitimately be either repo-root relative (`scripts/foo.mjs`) or task relative
 * (`src/server.ts`), so both are tried before the reference is reported as stale.
 *
 * Wired into `npm run verify`, so a rename that leaves a stale claim behind fails CI.
 *
 * Escape hatch: a line containing `doc-path-guard: ignore` is skipped, for prose that has to mention a
 * path that intentionally does not exist (e.g. documenting what the guard catches).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DOC_FILES = ['README.md', 'docs/GRADER-GUIDE.md', 'docs/VERIFICATION.md', 'docs/ARCHITECTURE.md'];

const TASK_DIRS = readdirSync(ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('task-'))
  .map((entry) => entry.name)
  .sort();

const PATH_PATTERN = /`((?:task-[a-z0-9-]+\/)?(?:src|tests|scripts|mock|config)\/[A-Za-z0-9_./-]+\.(?:ts|mjs|sql|json))`/g;
const IGNORE_MARKER = 'doc-path-guard: ignore';

const missing = [];
let checked = 0;
let scannedFiles = 0;

for (const relativeDoc of DOC_FILES) {
  const absoluteDoc = join(ROOT, relativeDoc);
  if (!existsSync(absoluteDoc)) {
    missing.push({ doc: relativeDoc, path: '(document itself is missing)' });
    continue;
  }
  scannedFiles += 1;
  const text = readFileSync(absoluteDoc, 'utf8')
    .split('\n')
    .filter((line) => !line.includes(IGNORE_MARKER))
    .join('\n');

  for (const match of text.matchAll(PATH_PATTERN)) {
    const cited = match[1];
    checked += 1;
    const found = cited.startsWith('task-')
      ? existsSync(join(ROOT, cited))
      : existsSync(join(ROOT, cited)) || TASK_DIRS.some((taskDir) => existsSync(join(ROOT, taskDir, cited)));

    if (!found) missing.push({ doc: relativeDoc, path: cited });
  }
}

if (missing.length > 0) {
  console.error(`doc paths: ${missing.length} stale reference(s) across ${scannedFiles} document(s)\n`);
  for (const entry of missing) {
    console.error(`  ${entry.doc}  →  ${entry.path}`);
  }
  console.error('\nEither the file moved (update the doc) or the claim is wrong (remove it).');
  process.exit(1);
}

console.log(
  `doc paths: OK (${checked} file reference(s) across ${scannedFiles} document(s) resolve in ${TASK_DIRS.length} task folder(s))`
);
