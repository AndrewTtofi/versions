// Latest-version lookups against the public package registries.
// Every function resolves to a version string, or null if the package
// does not exist. Network failures are retried, then thrown.

import { parseImageRef, tagShape } from './manifests/docker.js';
import { compareVersions, maxVersion } from './semver.js';
import { DOCKER_REGISTRIES, isSafeVersion, isValidPackageName } from './validate.js';

export const USER_AGENT = 'agent-versions (+https://github.com/AndrewTtofi/versions)';

const NPM_REGISTRY = (process.env.AGENT_VERSIONS_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');
const PYPI = (process.env.AGENT_VERSIONS_PYPI || 'https://pypi.org').replace(/\/$/, '');
const CRATES_INDEX = (process.env.AGENT_VERSIONS_CRATES_INDEX || 'https://index.crates.io').replace(/\/$/, '');
const GO_PROXY = (process.env.GOPROXY?.split(',')[0]?.startsWith('http') ? process.env.GOPROXY.split(',')[0] : 'https://proxy.golang.org').replace(/\/$/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET with retries on 429, 5xx and network errors. Any other response is returned as is. */
async function request(url, { headers = {}, retries = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let wait = 500 * 2 ** attempt;
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, ...headers },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status < 500 && res.status !== 429) return res;
      lastError = new Error(`${res.status} ${res.statusText} for ${url}`);
      if (res.status === 429) {
        // Honour Retry-After (seconds), capped so one package can't stall a run.
        const after = Number(res.headers.get('retry-after'));
        wait = Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * 2 ** attempt, 30_000);
      }
    } catch (err) {
      lastError = err;
    }
    if (attempt < retries) await sleep(wait + Math.random() * 250);
  }
  throw lastError;
}

export async function fetchText(url, opts) {
  const res = await request(url, opts);
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

export async function fetchJSON(url, opts) {
  const text = await fetchText(url, opts);
  return text == null ? null : JSON.parse(text);
}

/** Registry path for a (validated) npm name: "@scope/pkg" -> "@scope%2fpkg". */
const npmPath = (name) => name.replaceAll('/', '%2f');

export async function latestNpm(name) {
  const data = await fetchJSON(`${NPM_REGISTRY}/${npmPath(name)}/latest`);
  return data?.version ?? null;
}

export async function npmManifest(name) {
  return fetchJSON(`${NPM_REGISTRY}/${npmPath(name)}/latest`);
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

// --- Container images (OCI distribution API) ----------------------------

const DOCKER_API_HOST = { 'docker.io': 'registry-1.docker.io' };
// Token endpoints a registry may send us to, besides itself.
const DOCKER_TOKEN_HOSTS = { 'registry-1.docker.io': 'auth.docker.io', 'registry.gitlab.com': 'gitlab.com' };
const MAX_TAG_PAGES = 50;
const TAG_CACHE_MS = 10 * 60_000;
const tagCache = new Map();

async function registryToken(challenge, apiHost, repository) {
  const params = Object.fromEntries([...(challenge ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  if (!/^Bearer\s/i.test(challenge ?? '') || !params.realm) return null;
  const realm = new URL(params.realm);
  if (realm.protocol !== 'https:' || (realm.hostname !== apiHost && realm.hostname !== DOCKER_TOKEN_HOSTS[apiHost])) {
    throw new Error(`Unexpected token endpoint ${realm.hostname} for ${apiHost}`);
  }
  if (params.service) realm.searchParams.set('service', params.service);
  realm.searchParams.set('scope', params.scope?.startsWith('repository:') ? params.scope : `repository:${repository}:pull`);
  const data = await fetchJSON(realm.href);
  return data?.token ?? data?.access_token ?? null;
}

/** Every tag of an image, or null if the repository doesn't exist (or is private). */
async function registryTags(host, repository) {
  const key = `${host}/${repository}`;
  const cached = tagCache.get(key);
  if (cached && Date.now() - cached.at < TAG_CACHE_MS) return cached.tags;

  const apiHost = DOCKER_API_HOST[host] ?? host;
  const origin = `https://${apiHost}`;
  let url = `${origin}/v2/${repository}/tags/list?n=1000`;
  let token = null;
  const tags = [];
  for (let page = 0; url && page < MAX_TAG_PAGES; page++) {
    const auth = () => (token ? { authorization: `Bearer ${token}` } : {});
    let res = await request(url, { headers: auth() });
    if (res.status === 401 && !token) {
      token = await registryToken(res.headers.get('www-authenticate'), apiHost, repository);
      if (token) res = await request(url, { headers: auth() });
    }
    // Registries answer 401/403 for repositories that don't exist.
    if ([401, 403, 404].includes(res.status)) {
      if (page === 0) return null;
      break;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    tags.push(...((await res.json()).tags ?? []).filter((t) => typeof t === 'string'));
    const next = res.headers.get('link')?.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    url = next ? new URL(next[1], origin).href : null;
    if (url && !url.startsWith(`${origin}/`)) url = null;
  }
  tagCache.set(key, { at: Date.now(), tags });
  return tags;
}

/** Highest tag with exactly this shape ("x-alpine" matches "24-alpine", not "24.9-alpine"). */
export function bestTag(tags, shape) {
  let best = null;
  for (const t of tags) if (tagShape(t) === shape && (best === null || compareVersions(t, best) > 0)) best = t;
  return best;
}

/**
 * Latest tag for an image. "node:20-alpine" (or "node:x-alpine") finds the newest
 * "N-alpine" tag; a bare "node" finds the newest plain x.y.z (then x.y, then x) tag.
 */
export async function latestDocker(ref) {
  const { host, repository, tag } = parseImageRef(ref);
  if (!DOCKER_REGISTRIES.has(host)) throw new Error(`Unsupported registry: ${host}`);
  const shapes = tag ? [tagShape(tag)] : ['x.x.x', 'x.x', 'x'];
  if (!shapes[0]) throw new Error(`Not a version tag: ${tag}`);
  const tags = await registryTags(host, repository);
  if (!tags) return null;
  for (const shape of shapes) {
    const best = bestTag(tags, shape);
    if (best) return best;
  }
  return null;
}

// --- Release dates (for the minimum-release-age safeguard) -------------

async function publishedNpm(name, version) {
  const doc = await fetchJSON(`${NPM_REGISTRY}/${npmPath(name)}`);
  return doc?.time?.[version] ?? null;
}

async function publishedPypi(name, version) {
  const data = await fetchJSON(`${PYPI}/pypi/${normalizePypiName(name)}/${encodeURIComponent(version)}/json`);
  const times = (data?.urls ?? []).map((u) => u.upload_time_iso_8601).filter(Boolean).sort();
  return times[0] ?? null;
}

// crates.io's API allows ~1 request/second; serialise these calls.
let crateQueue = Promise.resolve();
function publishedCrate(name, version) {
  const run = crateQueue.then(async () => {
    const data = await fetchJSON(`https://crates.io/api/v1/crates/${name}/${encodeURIComponent(version)}`);
    await sleep(1000);
    return data?.version?.created_at ?? null;
  });
  crateQueue = run.catch(() => {});
  return run;
}

async function publishedGo(module, version) {
  const data = await fetchJSON(`${GO_PROXY}/${escapeGoModule(module)}/@v/${encodeURIComponent(version)}.info`);
  return data?.Time ?? null;
}

// No docker entry: a tag's push time changes on every rebuild of the image, so it says
// nothing about when that version was released.
const PUBLISHED = { npm: publishedNpm, pypi: publishedPypi, cargo: publishedCrate, go: publishedGo };

/** ISO date a version was published, or null if the registry doesn't say. */
export async function publishedAt(ecosystem, name, version) {
  const lookup = PUBLISHED[ecosystem];
  if (!lookup) return null;
  if (!isValidPackageName(ecosystem, name) || !isSafeVersion(version)) throw new Error('Invalid package or version');
  const time = await lookup(name, version);
  return typeof time === 'string' && !Number.isNaN(Date.parse(time)) ? time : null;
}

const LOOKUPS = { npm: latestNpm, pypi: latestPypi, cargo: latestCrate, go: latestGo, docker: latestDocker };

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
