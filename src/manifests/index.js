import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import * as npm from './npm.js';
import * as pypi from './pypi.js';
import * as cargo from './cargo.js';
import * as gomod from './gomod.js';

export const PARSERS = [npm, pypi, cargo, gomod];

export function parserFor(filename) {
  return PARSERS.find((p) => p.matches(basename(filename))) ?? null;
}

/** Parse a manifest's text. Returns { ecosystem, deps } or null if unsupported. */
export function parseManifest(filename, text) {
  const parser = parserFor(filename);
  if (!parser) return null;
  return { ecosystem: parser.ecosystem, deps: parser.parse(text, basename(filename)) };
}

/** Apply [{ start, end, text }] edits to a string. */
export function applyEdits(text, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'target', 'vendor', 'dist', 'build', 'out',
  '.venv', 'venv', 'env', '.tox', '.nox', '__pycache__', '.next', '.turbo', '.cache', 'coverage',
]);

/** Find supported manifests under `dir`. */
export async function findManifests(dir, { recursive = true, maxDepth = 8 } = {}) {
  const found = [];
  async function walk(current, depth) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive && depth < maxDepth && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          await walk(full, depth + 1);
        }
      } else if (entry.isFile() && parserFor(entry.name)) {
        found.push(full);
      }
    }
  }
  const info = await stat(dir);
  if (info.isFile()) return parserFor(dir) ? [dir] : [];
  await walk(dir, 0);
  return found.sort();
}

export async function readManifest(path) {
  const text = await readFile(path, 'utf8');
  return { path, text, ...parseManifest(path, text) };
}
