// Latest-version lookups against the public package registries.
// Every function resolves to a version string, or null if the package
// does not exist. Network failures are retried, then thrown.

import { maxVersion } from './semver.js';
import { isSafeVersion, isValidPackageName } from './validate.js';

export const USER_AGENT = 'agent-versions (+https://github.com/AndrewTtofi/versions)';

const NPM_REGISTRY = (process.env.AGENT_VERSIONS_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');
const PYPI = (process.env.AGENT_VERSIONS_PYPI || 'https://pypi.org').replace(/\/$/, '');
const CRATES_INDEX = (process.env.AGENT_VERSIONS_CRATES_INDEX || 'https://index.crates.io').replace(/\/$/, '');
const GO_PROXY = (process.env.GOPROXY?.split(',')[0]?.startsWith('http') ? process.env.GOPROXY.split(',')[0] : 'https://proxy.golang.org').replace(/\/$/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchText(url, { headers = {}, retries = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, ...headers },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 404 || res.status === 410) return null;
      if (res.ok) return await res.text();
      lastError = new Error(`${res.status} ${res.statusText} for ${url}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      lastError = err;
    }
    if (attempt < retries) await sleep(500 * 2 ** attempt);
  }
  throw lastError;
}

export async function fetchJSON(url, opts) {
  const text = await fetchText(url, opts);
  return text == null ? null : JSON.parse(text);
}

export async function latestNpm(name) {
  const data = await fetchJSON(`${NPM_REGISTRY}/${name.replace('/', '%2f')}/latest`);
  return data?.version ?? null;
}

export async function npmManifest(name) {
  return fetchJSON(`${NPM_REGISTRY}/${name.replace('/', '%2f')}/latest`);
}

export function normalizePypiName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

export async function latestPypi(name) {
  const data = await fetchJSON(`${PYPI}/pypi/${normalizePypiName(name)}/json`);
  return data?.info?.version ?? null;
}

export function crateIndexPath(name) {
  const n = name.toLowerCase();
  if (n.length <= 2) return `${n.length}/${n}`;
  if (n.length === 3) return `3/${n[0]}/${n}`;
  return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
}

export async function latestCrate(name) {
  const text = await fetchText(`${CRATES_INDEX}/${crateIndexPath(name)}`);
  if (text == null) return null;
  const versions = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (!entry.yanked) versions.push(entry.vers);
  }
  return maxVersion(versions) ?? maxVersion(versions, { includePrerelease: true });
}

export function escapeGoModule(path) {
  return path.replace(/[A-Z]/g, (c) => '!' + c.toLowerCase());
}

export async function latestGo(module) {
  const data = await fetchJSON(`${GO_PROXY}/${escapeGoModule(module)}/@latest`);
  return data?.Version ?? null;
}

export async function latestGithubRelease(repo) {
  const headers = { accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const data = await fetchJSON(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
  return data?.tag_name ?? null;
}

const LOOKUPS = { npm: latestNpm, pypi: latestPypi, cargo: latestCrate, go: latestGo };

/** Validated lookup: rejects malformed names and anything that isn't a plain version. */
export async function lookupLatest(ecosystem, name) {
  const lookup = LOOKUPS[ecosystem];
  if (!lookup) throw new Error(`Unknown ecosystem: ${ecosystem}`);
  if (!isValidPackageName(ecosystem, name)) throw new Error(`Invalid ${ecosystem} package name`);
  const version = await lookup(name);
  if (version != null && !isSafeVersion(version)) throw new Error(`Registry returned an invalid version for ${name}`);
  return version;
}

/** A memoising resolver: resolve('npm', 'zod') -> '4.1.5'. */
export function createResolver() {
  const cache = new Map();
  return function resolve(ecosystem, name) {
    const key = `${ecosystem}:${name}`;
    if (!cache.has(key)) cache.set(key, lookupLatest(ecosystem, name));
    return cache.get(key);
  };
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
