// go.mod: `require` lines and blocks. Indirect requirements are reported
// under their own section so callers can leave them to `go mod tidy`.

export const ecosystem = 'go';

export function matches(filename) {
  return filename === 'go.mod';
}

const REQ_RE = /^(\s*(?:require\s+)?)(\S+)\s+(v\d+\.\d+\.\d+\S*)(\s*\/\/\s*indirect)?/;

export function parse(text) {
  const deps = [];
  let inBlock = false;
  let offset = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (/^require\s*\($/.test(trimmed)) inBlock = true;
    else if (inBlock && trimmed === ')') inBlock = false;
    else if (inBlock || /^require\s+\S/.test(trimmed)) {
      const m = line.match(REQ_RE);
      if (m && (inBlock || /require/.test(m[1]))) {
        const [, lead, name, version, indirect] = m;
        const start = offset + lead.length + name.length + line.slice(lead.length + name.length).indexOf(version);
        const dep = { name, spec: version, prefix: '', version, start, end: start + version.length, section: indirect ? 'indirect' : 'require' };
        // Pseudo-versions (v0.0.0-2024...-abcdef) pin a commit, not a release.
        if (/-\d{14}-[0-9a-f]{12}$/.test(version)) dep.skip = 'pseudo-version';
        deps.push(dep);
      }
    }
    offset += line.length + 1;
  }
  return deps;
}
