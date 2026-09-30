#!/usr/bin/env node
// Refreshes data/latest.json and VERSIONS.md. Run by .github/workflows/update.yml.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect } from '../src/collect.js';
import { renderMarkdown } from '../src/render.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sources = JSON.parse(await readFile(join(root, 'sources.json'), 'utf8'));

const outFile = join(root, 'data', 'latest.json');
let previous = null;
try {
  previous = JSON.parse(await readFile(outFile, 'utf8'));
} catch {}

const started = Date.now();
const snapshot = await collect(sources, { log: (m) => console.log(m), previous });

// Only bump the timestamp when something actually changed, so scheduled
// runs don't produce empty commits.
const strip = ({ generatedAt, errors, ...rest }) => JSON.stringify(rest);
const changed = !previous || strip(previous) !== strip(snapshot);
const generatedAt = changed ? new Date().toISOString() : previous.generatedAt;
const ordered = { schemaVersion: snapshot.schemaVersion, generatedAt, tools: snapshot.tools, packages: snapshot.packages, errors: snapshot.errors };

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, JSON.stringify(ordered, null, 2) + '\n');
await writeFile(join(root, 'VERSIONS.md'), renderMarkdown(ordered));

const total = Object.values(snapshot.packages).reduce((n, p) => n + Object.keys(p).length, 0);
console.log(`\n${changed ? 'Updated' : 'No changes'}: ${total} packages, ${snapshot.errors.length} errors, ${((Date.now() - started) / 1000).toFixed(1)}s`);
