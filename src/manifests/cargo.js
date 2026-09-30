// Cargo.toml: [dependencies], [dev-dependencies], [build-dependencies],
// [workspace.dependencies], target-specific tables and [dependencies.foo].

export const ecosystem = 'cargo';

export function matches(filename) {
  return filename === 'Cargo.toml';
}

const SPEC_RE = /^(\^|~|=|>=)?\s*(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)$/;
const isDepTable = (t) => /(^|\.)(dependencies|dev-dependencies|build-dependencies)$/.test(t);

function describe(name, spec, specStart, section, extra = '') {
  const pkg = extra.match(/\bpackage\s*=\s*"([^"]+)"/);
  const dep = { name: pkg ? pkg[1] : name, spec, section };
  if (pkg) dep.alias = name;
  if (/\b(path|git)\s*=/.test(extra) && !/\bversion\s*=/.test(extra)) {
    dep.skip = 'not a registry version';
    return dep;
  }
  if (/\bregistry\s*=/.test(extra)) {
    dep.skip = 'private registry';
    return dep;
  }
  const m = spec.trim().match(SPEC_RE);
  if (!m) {
    dep.skip = 'complex range';
    return dep;
  }
  dep.prefix = m[1] ?? '';
  dep.version = m[2];
  dep.start = specStart + spec.indexOf(m[2]);
  dep.end = dep.start + m[2].length;
  return dep;
}

export function parse(text) {
  const deps = [];
  let table = '';
  let subDep = null; // [dependencies.foo] style table state
  const lineRe = /^[^\n]*$/gm;
  let m;
  const flushSubDep = () => {
    if (subDep && subDep.version) {
      deps.push(describe(subDep.name, subDep.version[0], subDep.version[1], subDep.table, subDep.body));
    } else if (subDep && /\b(path|git)\s*=/.test(subDep.body)) {
      deps.push({ name: subDep.name, spec: '', section: subDep.table, skip: 'not a registry version' });
    }
    subDep = null;
  };
  while ((m = lineRe.exec(text))) {
    if (m[0] === '' && lineRe.lastIndex === m.index) lineRe.lastIndex++;
    const line = m[0];
    const header = line.match(/^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/);
    if (header) {
      flushSubDep();
      const parts = header[1].split('.');
      const last = parts.at(-1).replace(/["']/g, '');
      const parent = parts.slice(0, -1).join('.');
      if (parts.length > 1 && isDepTable(parent)) {
        subDep = { name: last, table: parent, body: '', version: null };
        table = '';
      } else {
        table = header[1];
      }
      continue;
    }
    if (subDep) {
      subDep.body += line + '\n';
      const v = line.match(/^\s*version\s*=\s*"([^"]*)"/);
      if (v) subDep.version = [v[1], m.index + line.indexOf('"') + 1];
      continue;
    }
    if (!isDepTable(table)) continue;
    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*/);
    if (!kv) continue;
    const name = kv[1];
    const rest = line.slice(kv[0].length);
    const valueStart = m.index + kv[0].length;
    if (rest.startsWith('"')) {
      const s = rest.match(/^"([^"]*)"/);
      deps.push(describe(name, s[1], valueStart + 1, table));
    } else if (rest.startsWith('{')) {
      if (/\bworkspace\s*=\s*true/.test(rest)) continue;
      const v = rest.match(/\bversion\s*=\s*"([^"]*)"/);
      if (v) {
        deps.push(describe(name, v[1], valueStart + v.index + v[0].length - 1 - v[1].length, table, rest));
      } else {
        deps.push(describe(name, '', valueStart, table, rest));
      }
    }
  }
  flushSubDep();
  return deps;
}
