// Python: requirements*.txt and pyproject.toml (PEP 621, PEP 735
// dependency groups, uv dev-dependencies, build-system and Poetry tables).

export const ecosystem = 'pypi';

export function matches(filename) {
  return filename === 'pyproject.toml' || /^requirements.*\.(txt|in)$/.test(filename);
}

const PEP508_RE = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(\[[^\]]*\])?\s*([^;]*?)\s*(;.*)?$/;
const SINGLE_CLAUSE_RE = /^(===|==|>=|~=)\s*(\d[0-9A-Za-z.!+*-]*)$/;

/** Parse one PEP 508 requirement located at `offset` in the file. */
export function parseRequirement(req, offset, section) {
  const m = req.match(PEP508_RE);
  if (!m) return null;
  const [, name, , specs] = m;
  const dep = { name, spec: specs, section };
  if (!specs) {
    dep.skip = 'unpinned';
    return dep;
  }
  if (specs.startsWith('@')) {
    dep.skip = 'not a registry version';
    return dep;
  }
  const clause = specs.match(SINGLE_CLAUSE_RE);
  if (!clause || clause[2].includes('*')) {
    dep.skip = 'complex range';
    return dep;
  }
  dep.prefix = clause[1];
  dep.version = clause[2];
  const specIdx = req.indexOf(specs, name.length);
  dep.start = offset + specIdx + specs.lastIndexOf(clause[2]);
  dep.end = dep.start + clause[2].length;
  return dep;
}

function parseRequirementsTxt(text) {
  const deps = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const body = line.replace(/(^|\s)#.*$/, '').replace(/\s+\\$/, '');
    if (body.trim() && !/^\s*-/.test(body) && !body.includes('://')) {
      const dep = parseRequirement(body, offset, 'requirements');
      if (dep) deps.push(dep);
    }
    offset += line.length + 1;
  }
  return deps;
}

/** Yield [stringValue, startOffsetOfValue] for strings inside a TOML array starting at `open`. */
function arrayStrings(text, open) {
  const out = [];
  let i = open + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === ']') break;
    if (c === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      const q = triple ? c.repeat(3) : c;
      const start = i + q.length;
      let j = start;
      while (j < text.length && !text.startsWith(q, j)) j += text[j] === '\\' && c === '"' ? 2 : 1;
      out.push([text.slice(start, j), start]);
      i = j + q.length;
      continue;
    }
    i++;
  }
  return out;
}

const PEP621_ARRAY_TABLES = [
  (table, key) => table === 'project' && key === 'dependencies',
  (table) => table === 'project.optional-dependencies',
  (table) => table === 'dependency-groups',
  (table, key) => table === 'build-system' && key === 'requires',
  (table, key) => table === 'tool.uv' && (key === 'dev-dependencies' || key === 'constraint-dependencies' || key === 'override-dependencies'),
];

const isPoetryTable = (table) =>
  /^tool\.poetry\.(dependencies|dev-dependencies|group\.[^.]+\.dependencies)$/.test(table);

const POETRY_SPEC_RE = /^(\^|~=|~|>=|==|=)?\s*(\d[0-9A-Za-z.!+-]*)$/;

function parsePoetryValue(name, raw, valueStart, table) {
  const dep = { name, spec: raw, section: table };
  const m = raw.match(POETRY_SPEC_RE);
  if (!m) {
    dep.skip = raw === '*' ? 'unpinned' : 'complex range';
    return dep;
  }
  dep.prefix = m[1] ?? '';
  dep.version = m[2];
  dep.start = valueStart + raw.lastIndexOf(m[2]);
  dep.end = dep.start + m[2].length;
  return dep;
}

function parsePyproject(text) {
  const deps = [];
  let table = '';
  const lineRe = /^[^\n]*$/gm;
  let m;
  while ((m = lineRe.exec(text))) {
    const line = m[0];
    const lineStart = m.index;
    if (m[0] === '' && lineRe.lastIndex === m.index) lineRe.lastIndex++;
    const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
    if (header) {
      table = header[1].replace(/["']/g, '');
      continue;
    }
    const kv = line.match(/^\s*("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=\s*/);
    if (!kv) continue;
    const key = kv[1].replace(/["']/g, '');
    const valueStart = lineStart + kv[0].length;

    if (text[valueStart] === '[' && PEP621_ARRAY_TABLES.some((f) => f(table, key))) {
      for (const [value, start] of arrayStrings(text, valueStart)) {
        const dep = parseRequirement(value, start, `${table}.${key}`);
        if (dep) deps.push(dep);
      }
      continue;
    }

    if (isPoetryTable(table) && key.toLowerCase() !== 'python') {
      const str = text.slice(valueStart).match(/^(["'])([^"'\n]*)\1/);
      if (str) {
        deps.push(parsePoetryValue(key, str[2], valueStart + 1, table));
        continue;
      }
      const inline = text.slice(valueStart).match(/^\{[^}\n]*\}/);
      if (inline) {
        if (/\b(path|git|url)\s*=/.test(inline[0])) {
          deps.push({ name: key, spec: inline[0], section: table, skip: 'not a registry version' });
          continue;
        }
        const ver = inline[0].match(/\bversion\s*=\s*(["'])([^"']*)\1/);
        if (ver) {
          const at = valueStart + ver.index + ver[0].length - 1 - ver[2].length;
          deps.push(parsePoetryValue(key, ver[2], at, table));
        }
      }
    }
  }
  return deps;
}

export function parse(text, filename = 'requirements.txt') {
  return filename === 'pyproject.toml' ? parsePyproject(text) : parseRequirementsTxt(text);
}
