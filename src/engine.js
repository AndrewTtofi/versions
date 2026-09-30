import { writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { applyEdits, findManifests, parseManifest, readManifest } from './manifests/index.js';
import { createResolver, normalizePypiName, pool, publishedAt as registryPublishedAt } from './registries.js';
import { bumpLevel, bumpVersionText, isMajorBump } from './semver.js';
import { isSafeVersion } from './validate.js';

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Identity of a package across manifests (PyPI names are case/punctuation-insensitive). */
export function packageKey(ecosystem, name) {
  return `${ecosystem}:${ecosystem === 'pypi' ? normalizePypiName(name) : name}`;
}

export function makeMatcher(patterns = []) {
  const res = patterns.map(globToRegExp);
  return (name) => res.some((re) => re.test(name));
}

/**
 * Inspect every manifest under `target` and work out which dependencies
 * are behind the latest published release.
 */
export async function analyze(target, opts = {}) {
  const { recursive = true } = opts;
  const paths = await findManifests(target, { recursive });
  const files = [];
  for (const path of paths) {
    const manifest = await readManifest(path);
    if (!manifest.ecosystem) continue;
    files.push({ path, relPath: relative(target, path) || path, ecosystem: manifest.ecosystem, text: manifest.text, deps: manifest.deps });
  }
  await resolveFiles(files, opts);
  return { target, files };
}

/** Check a manifest given as text (no filesystem access needed). */
export async function analyzeManifestText(filename, text, opts = {}) {
  const parsed = parseManifest(filename, text);
  if (!parsed) throw new Error(`Unsupported manifest: ${filename}. Expected package.json, pyproject.toml, requirements*.txt, Cargo.toml or go.mod.`);
  if (opts.maxDeps && parsed.deps.length > opts.maxDeps) throw new Error(`Manifest has more than ${opts.maxDeps} dependencies`);
  const file = { path: filename, relPath: filename, ecosystem: parsed.ecosystem, text, deps: parsed.deps };
  await resolveFiles([file], opts);
  const edits = file.deps.filter((d) => d.status === 'outdated').map((d) => ({ start: d.start, end: d.end, text: d.next }));
  return { file, updatedText: applyEdits(text, edits) };
}

async function resolveFiles(files, opts) {
  const {
    resolve = createResolver(),
    exclude = [],
    include = [],
    noMajor = false,
    includePeer = false,
    includeIndirect = false,
    tracked = null, // Set of "ecosystem:name" to restrict to, or null for all
    concurrency = 12,
    minAgeDays = 0,
    publishedAt = registryPublishedAt,
    now = Date.now(),
  } = opts;
  const isExcluded = makeMatcher(exclude);
  const isIncluded = include.length ? makeMatcher(include) : () => true;
  const lookups = new Map();
  for (const file of files) {
    for (const dep of file.deps) {
      if (dep.skip) {
        dep.status = 'skipped';
        dep.reason = dep.skip;
      } else if (isExcluded(dep.name) || !isIncluded(dep.name)) {
        dep.status = 'skipped';
        dep.reason = 'excluded by config';
      } else if (dep.section === 'peerDependencies' && !includePeer) {
        dep.status = 'skipped';
        dep.reason = 'peer dependency (use --peer)';
      } else if (dep.section === 'indirect' && !includeIndirect) {
        dep.status = 'skipped';
        dep.reason = 'indirect (use --indirect)';
      } else if (tracked && !tracked.has(packageKey(file.ecosystem, dep.name))) {
        dep.status = 'skipped';
        dep.reason = 'not used by tracked AI tools';
      } else {
        lookups.set(`${file.ecosystem}:${dep.name}`, [file.ecosystem, dep.name]);
      }
    }
  }

  const latest = new Map();
  await pool([...lookups.entries()], concurrency, async ([key, [eco, name]]) => {
    try {
      latest.set(key, { version: await resolve(eco, name) });
    } catch (err) {
      latest.set(key, { error: err.message });
    }
  });

  for (const file of files) {
    for (const dep of file.deps) {
      if (dep.status) continue;
      const found = latest.get(`${file.ecosystem}:${dep.name}`);
      if (found.error) {
        dep.status = 'error';
        dep.reason = found.error;
        continue;
      }
      if (!found.version) {
        dep.status = 'error';
        dep.reason = 'not found in registry';
        continue;
      }
      if (!isSafeVersion(found.version)) {
        dep.status = 'error';
        dep.reason = 'resolver returned an invalid version';
        continue;
      }
      dep.latest = found.version;
      const next = bumpVersionText(dep.version, found.version);
      if (!next) {
        dep.status = 'current';
        continue;
      }
      dep.next = next;
      dep.major = isMajorBump(dep.version, next);
      dep.level = bumpLevel(dep.version, next);
      if (dep.major && noMajor) {
        dep.status = 'held';
        dep.reason = 'major update (remove --no-major to apply)';
      } else {
        dep.status = 'outdated';
      }
    }
  }

  // Minimum release age: fresh releases are where compromised packages live.
  if (minAgeDays > 0) {
    const fresh = [];
    for (const file of files) for (const d of file.deps) if (d.status === 'outdated') fresh.push([file.ecosystem, d]);
    const cache = new Map();
    await pool(fresh, 6, async ([eco, d]) => {
      const key = `${eco}:${d.name}@${d.latest}`;
      if (!cache.has(key)) cache.set(key, publishedAt(eco, d.name, d.latest).catch(() => null));
      const time = await cache.get(key);
      if (!time) return; // registry doesn't expose a date; nothing to judge by
      d.publishedAt = time;
      const ageDays = (now - Date.parse(time)) / 86_400_000;
      if (ageDays < minAgeDays) {
        d.status = 'held';
        d.reason = `released ${ageDays < 1 ? `${Math.max(1, Math.round(ageDays * 24))}h` : `${ageDays.toFixed(1)}d`} ago (minimum age ${minAgeDays}d)`;
      }
    });
  }
}

/** Write every `outdated` bump back to disk. Returns the number of edits. */
export async function applyUpdates(analysis) {
  let count = 0;
  for (const file of analysis.files) {
    const edits = file.deps
      .filter((d) => d.status === 'outdated')
      .map((d) => ({ start: d.start, end: d.end, text: d.next }));
    if (!edits.length) continue;
    await writeFile(file.path, applyEdits(file.text, edits));
    count += edits.length;
  }
  return count;
}

export function summarize(analysis) {
  const counts = { outdated: 0, held: 0, current: 0, skipped: 0, error: 0 };
  for (const file of analysis.files) for (const d of file.deps) counts[d.status]++;
  return counts;
}
