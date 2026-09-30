// Builds the published snapshot: the latest version of every tracked AI
// tool and of every dependency their public manifests declare.

import { basename } from 'node:path';
import { parseManifest } from './manifests/index.js';
import {
  createResolver,
  fetchJSON,
  fetchText,
  latestGithubRelease,
  normalizePypiName,
  npmManifest,
  pool,
} from './registries.js';
import { isValidPackageName } from './validate.js';

export const MANIFEST_RE = /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|requirements[^/]*\.(txt|in))$/;
export const DEFAULT_EXCLUDE_RE =
  /(^|\/)(node_modules|vendor|third_party|test|tests|__tests__|testdata|test-data|fixtures?|examples?|samples?|docs?|e2e|benchmarks?|bench|evals?|integration-tests|\.github|\.devcontainer|playground|templates?)(\/|$)/i;
const MAX_MANIFESTS_PER_REPO = 400;

function githubHeaders() {
  const headers = { accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

export async function listRepoManifests(repo, { exclude } = {}) {
  const tree = await fetchJSON(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`, {
    headers: githubHeaders(),
  });
  if (!tree) throw new Error(`repository ${repo} not found`);
  const extra = exclude ? new RegExp(exclude) : null;
  return tree.tree
    .filter((e) => e.type === 'blob' && MANIFEST_RE.test(e.path))
    .map((e) => e.path)
    .filter((p) => !DEFAULT_EXCLUDE_RE.test(p) && !(extra && extra.test(p)))
    .slice(0, MAX_MANIFESTS_PER_REPO);
}

/** Names a repository publishes itself - these are internal, not dependencies. */
export function ownPackageNames(filename, text) {
  const names = [];
  const file = basename(filename);
  if (file === 'package.json') {
    try {
      const name = JSON.parse(text).name;
      if (name) names.push(['npm', name]);
    } catch {}
  } else if (file === 'Cargo.toml') {
    const m = text.match(/^\[package\][^[]*?^name\s*=\s*"([^"]+)"/m);
    if (m) names.push(['cargo', m[1]]);
  } else if (file === 'pyproject.toml') {
    const m = text.match(/^\[(?:project|tool\.poetry)\][^[]*?^name\s*=\s*["']([^"']+)["']/m);
    if (m) names.push(['pypi', normalizePypiName(m[1])]);
  } else if (file === 'go.mod') {
    const m = text.match(/^module\s+(\S+)/m);
    if (m) names.push(['go', m[1]]);
  }
  return names;
}

// Release tags and update-API values are third-party strings; keep them inert.
const safeLabel = (v) => (typeof v === 'string' && /^[\w.+/-]{1,64}$/.test(v) ? v : null);

function keyFor(ecosystem, name) {
  return `${ecosystem}:${ecosystem === 'pypi' ? normalizePypiName(name) : name}`;
}

async function repoDependencies(repoSpec, log) {
  const { repo } = repoSpec;
  const paths = repoSpec.paths ?? (await listRepoManifests(repo, repoSpec));
  const files = await pool(paths, 8, async (path) => {
    try {
      const text = await fetchText(`https://raw.githubusercontent.com/${repo}/HEAD/${path}`);
      return text == null ? null : { path, text };
    } catch (err) {
      log(`  ! ${repo}/${path}: ${err.message}`);
      return null;
    }
  });

  const own = new Set();
  const found = [];
  for (const file of files.filter(Boolean)) {
    for (const [eco, name] of ownPackageNames(file.path, file.text)) own.add(`${eco}:${name}`);
    const parsed = parseManifest(file.path, file.text);
    if (!parsed) continue;
    for (const dep of parsed.deps) {
      if (dep.skip === 'not a registry version' || dep.skip === 'private registry') continue;
      found.push({ ecosystem: parsed.ecosystem, name: dep.name, source: `${repo}/${file.path}` });
    }
  }
  const goModules = [...own].filter((k) => k.startsWith('go:')).map((k) => k.slice(3));
  return {
    manifests: paths.length,
    deps: found.filter(
      (d) =>
        !own.has(keyFor(d.ecosystem, d.name)) &&
        !(d.ecosystem === 'go' && goModules.some((m) => d.name === m || d.name.startsWith(m + '/'))),
    ),
  };
}

async function npmPackageDependencies(name) {
  const manifest = await npmManifest(name);
  if (!manifest) throw new Error(`npm package ${name} not found`);
  return Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).map((dep) => ({
    ecosystem: 'npm',
    name: dep,
    source: `npm:${name}`,
  }));
}

/**
 * @param {{ tools: object[] }} sources contents of sources.json
 * @param {{ log?: (msg: string) => void, resolve?: Function }} opts
 */
export async function collect(sources, { log = () => {}, resolve = createResolver(), previous = null, concurrency = 6 } = {}) {
  const errors = [];
  const packages = new Map(); // key -> { ecosystem, name, usedBy: Set }
  const tools = {};

  const add = (toolId, dep) => {
    if (!isValidPackageName(dep.ecosystem, dep.name)) return;
    const key = keyFor(dep.ecosystem, dep.name);
    if (!packages.has(key)) packages.set(key, { ecosystem: dep.ecosystem, name: dep.name, usedBy: new Set() });
    packages.get(key).usedBy.add(toolId);
  };

  for (const tool of sources.tools) {
    log(`- ${tool.name}`);
    const entry = { name: tool.name, homepage: tool.homepage, install: tool.install, packages: {}, manifests: 0 };
    tools[tool.id] = entry;

    for (const [eco, names] of Object.entries(tool.packages ?? {})) {
      for (const name of names) {
        try {
          entry.packages[eco] ??= {};
          entry.packages[eco][name] = await resolve(eco, name);
        } catch (err) {
          errors.push({ tool: tool.id, package: `${eco}:${name}`, error: err.message });
        }
      }
    }
    if (tool.versionUrl) {
      try {
        const data = await fetchJSON(tool.versionUrl.url);
        entry.release = safeLabel(tool.versionUrl.field.split('.').reduce((o, k) => o?.[k], data));
      } catch (err) {
        errors.push({ tool: tool.id, versionUrl: tool.versionUrl.url, error: err.message });
      }
    }
    if (tool.releases) {
      try {
        entry.release = safeLabel(await latestGithubRelease(tool.releases));
      } catch (err) {
        errors.push({ tool: tool.id, releases: tool.releases, error: err.message });
      }
    }
    for (const name of tool.packageDeps?.npm ?? []) {
      try {
        for (const dep of await npmPackageDependencies(name)) add(tool.id, dep);
      } catch (err) {
        errors.push({ tool: tool.id, package: `npm:${name}`, error: err.message });
      }
    }
    for (const repoSpec of tool.repos ?? []) {
      try {
        const { manifests, deps } = await repoDependencies(repoSpec, log);
        entry.manifests += manifests;
        for (const dep of deps) add(tool.id, dep);
        log(`  ${repoSpec.repo}: ${manifests} manifests, ${deps.length} dependency references`);
      } catch (err) {
        errors.push({ tool: tool.id, repo: repoSpec.repo, error: err.message });
        log(`  ! ${repoSpec.repo}: ${err.message}`);
      }
    }
  }

  log(`Resolving latest versions for ${packages.size} packages...`);
  const list = [...packages.values()];
  await pool(list, concurrency, async (pkg) => {
    try {
      pkg.latest = await resolve(pkg.ecosystem, pkg.name);
      if (!pkg.latest) errors.push({ package: `${pkg.ecosystem}:${pkg.name}`, error: 'not found in registry' });
    } catch (err) {
      // Transient failure (rate limit, outage): keep the last published value
      // rather than dropping the package from the feed.
      const known = previous?.packages?.[pkg.ecosystem]?.[pkg.name]?.latest;
      if (known) pkg.latest = known;
      errors.push({ package: `${pkg.ecosystem}:${pkg.name}`, error: err.message, ...(known ? { kept: known } : {}) });
    }
  });

  const byEcosystem = {};
  for (const pkg of list.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!pkg.latest) continue;
    byEcosystem[pkg.ecosystem] ??= {};
    byEcosystem[pkg.ecosystem][pkg.name] = { latest: pkg.latest, usedBy: [...pkg.usedBy].sort() };
  }
  const sortedEcosystems = Object.fromEntries(Object.keys(byEcosystem).sort().map((k) => [k, byEcosystem[k]]));
  return { schemaVersion: 1, tools, packages: sortedEcosystems, errors };
}
