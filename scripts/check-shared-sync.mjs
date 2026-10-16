#!/usr/bin/env node
// Guard for the twice-vendored `@devdigest/shared` contracts.
//
// The canonical copy is server/src/vendor/shared; client/ keeps its OWN copy
// (see CLAUDE.md). The two must stay byte-identical — a drift silently breaks
// the web↔api lockstep (e.g. a field added on one side only). This script
// fails with a per-file report when they differ.
//
//   node scripts/check-shared-sync.mjs
//
// Zero dependencies on purpose: CI runs it without installing any package.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const CANONICAL = join(ROOT, 'server/src/vendor/shared');
const COPY = join(ROOT, 'client/src/vendor/shared');

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(relative(dir, join(entry.parentPath, entry.name)));
  }
  return out.sort();
}

const [canonical, copy] = await Promise.all([listFiles(CANONICAL), listFiles(COPY)]);
const copySet = new Set(copy);
const problems = [];

for (const file of canonical) {
  if (!copySet.has(file)) {
    problems.push(`missing in client copy: ${file}`);
    continue;
  }
  const [a, b] = await Promise.all([
    readFile(join(CANONICAL, file)),
    readFile(join(COPY, file)),
  ]);
  if (!a.equals(b)) problems.push(`content differs: ${file}`);
}
const canonicalSet = new Set(canonical);
for (const file of copy) {
  if (!canonicalSet.has(file)) problems.push(`only in client copy: ${file}`);
}

if (problems.length > 0) {
  console.error('✗ @devdigest/shared copies are out of sync');
  console.error('  canonical: server/src/vendor/shared · copy: client/src/vendor/shared\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nEdit both copies in lockstep (server is canonical).');
  process.exit(1);
}
console.log(`✓ @devdigest/shared in sync (${canonical.length} files)`);
