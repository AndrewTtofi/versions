// Loads the published snapshot (data/latest.json), which the scheduled
// GitHub Action refreshes. Falls back to the copy bundled with the package.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageKey } from './engine.js';
import { fetchJSON } from './registries.js';

export const SNAPSHOT_URL =
  process.env.AGENT_VERSIONS_SNAPSHOT_URL ||
  'https://raw.githubusercontent.com/AndrewTtofi/versions/main/data/latest.json';

const BUNDLED = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'latest.json');

let cached;

export function loadSnapshot({ offline = false } = {}) {
  cached ??= (async () => {
    if (!offline) {
      try {
        const remote = await fetchJSON(SNAPSHOT_URL, { retries: 1 });
        if (remote?.packages) return { ...remote, source: SNAPSHOT_URL };
      } catch {}
    }
    const local = JSON.parse(await readFile(BUNDLED, 'utf8'));
    return { ...local, source: BUNDLED };
  })();
  return cached;
}

/** Set of package keys used by at least one tracked tool (optionally one tool). */
export function trackedSet(snapshot, toolId) {
  const set = new Set();
  for (const [eco, pkgs] of Object.entries(snapshot.packages)) {
    for (const [name, p] of Object.entries(pkgs)) {
      if (!toolId || p.usedBy.includes(toolId)) set.add(packageKey(eco, name));
    }
  }
  return set;
}

/** A resolver that answers from the snapshot only (no registry traffic). */
export function snapshotResolver(snapshot) {
  const index = new Map();
  for (const [eco, pkgs] of Object.entries(snapshot.packages)) {
    for (const [name, p] of Object.entries(pkgs)) index.set(packageKey(eco, name), p.latest);
  }
  for (const tool of Object.values(snapshot.tools)) {
    for (const [eco, pkgs] of Object.entries(tool.packages ?? {})) {
      for (const [name, v] of Object.entries(pkgs)) if (v) index.set(packageKey(eco, name), v);
    }
  }
  return async (eco, name) => index.get(packageKey(eco, name)) ?? null;
}
