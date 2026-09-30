// package.json: dependencies, devDependencies, optionalDependencies,
// peerDependencies, overrides, and pnpm/bun style catalogs.

export const ecosystem = 'npm';

export function matches(filename) {
  return filename === 'package.json';
}

const SPEC_RE = /^(\^|~|>=|=)?\s*(v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)$/;

function collectSections(pkg) {
  const sections = [];
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (pkg[key] && typeof pkg[key] === 'object') sections.push([key, pkg[key]]);
  }
  if (pkg.overrides && typeof pkg.overrides === 'object') {
    const flat = Object.fromEntries(Object.entries(pkg.overrides).filter(([, v]) => typeof v === 'string'));
    sections.push(['overrides', flat]);
  }
  const catalogHosts = [pkg, pkg.workspaces && !Array.isArray(pkg.workspaces) ? pkg.workspaces : null];
  for (const host of catalogHosts) {
    if (!host) continue;
    if (host.catalog && typeof host.catalog === 'object') sections.push(['catalog', host.catalog]);
    if (host.catalogs && typeof host.catalogs === 'object') {
      for (const [name, entries] of Object.entries(host.catalogs)) {
        if (entries && typeof entries === 'object') sections.push([`catalogs.${name}`, entries]);
      }
    }
  }
  return sections;
}

export function parse(text) {
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  const wanted = new Map(); // "name\0spec" -> [section, ...]
  for (const [section, entries] of collectSections(pkg)) {
    for (const [name, spec] of Object.entries(entries)) {
      if (typeof spec !== 'string') continue;
      const key = `${name}\0${spec}`;
      if (!wanted.has(key)) wanted.set(key, []);
      wanted.get(key).push(section);
    }
  }

  // Locate each "name": "spec" pair in the raw text so edits keep formatting.
  const deps = [];
  const seen = new Map();
  const pairRe = /"((?:[^"\\]|\\.)+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = pairRe.exec(text))) {
    const [, name, spec] = m;
    const key = `${name}\0${spec}`;
    const sections = wanted.get(key);
    if (!sections) continue;
    const idx = seen.get(key) ?? 0;
    if (idx >= sections.length) continue;
    seen.set(key, idx + 1);
    const specStart = m.index + m[0].length - 1 - spec.length;
    deps.push(describe(name, spec, sections[idx], specStart));
  }
  return deps;
}

function describe(name, spec, section, specStart) {
  // Override keys may carry a selector: "qs@<6.16.0": "6.16.0".
  const bare = section === 'overrides' ? name.replace(/^(@?[^@]+)@.*$/, '$1') : name;
  const dep = { name: bare, spec, section };
  const m = spec.trim().match(SPEC_RE);
  if (!m) {
    dep.skip = /^(workspace|file|link|portal|git|git\+|github|http|https|npm|catalog):/.test(spec) || spec.includes('/')
      ? 'not a registry version'
      : 'complex range';
    return dep;
  }
  dep.prefix = m[1] ?? '';
  dep.version = m[2];
  const offset = spec.indexOf(m[2]);
  dep.start = specStart + offset;
  dep.end = dep.start + m[2].length;
  return dep;
}
