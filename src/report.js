import { summarize } from './engine.js';

const ALIASES = { pip: 'pypi', py: 'pypi', python: 'pypi', crates: 'cargo', rust: 'cargo', crate: 'cargo', golang: 'go', node: 'npm', js: 'npm' };

/** "npm:zod", "pypi:requests", "cargo:serde", "go:github.com/x/y" or bare "zod". */
export function parsePackageRef(ref) {
  const m = ref.match(/^([a-z]+):(.+)$/i);
  if (m) {
    const eco = ALIASES[m[1].toLowerCase()] ?? m[1].toLowerCase();
    if (['npm', 'pypi', 'cargo', 'go'].includes(eco)) return [eco, m[2]];
  }
  if (/^[a-z0-9-]+\.[a-z]{2,}\/.+/i.test(ref)) return ['go', ref];
  return ['npm', ref];
}

const color = (code) => (s) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = { red: color(31), green: color(32), yellow: color(33), dim: color(2), bold: color(1) };

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => stripAnsi(r[i]).length)));
  return rows.map((r) => r.map((cell, i) => cell + ' '.repeat(widths[i] - stripAnsi(cell).length)).join('  ').trimEnd()).join('\n');
}
const stripAnsi = (s) => String(s).replace(/\x1b\[\d+m/g, '');

export function formatAnalysis(analysis, { verbose = false } = {}) {
  const lines = [];
  for (const file of analysis.files) {
    const shown = file.deps.filter((d) => d.status === 'outdated' || d.status === 'held' || d.status === 'error' || (verbose && d.status !== 'current'));
    if (!shown.length) continue;
    lines.push('', c.bold(`${file.relPath}`) + c.dim(` (${file.ecosystem})`));
    const rows = [[c.dim('package'), c.dim('current'), c.dim('latest'), c.dim('change')]];
    for (const d of shown) {
      if (d.status === 'outdated' || d.status === 'held') {
        const mark = d.status === 'held' ? c.dim('held: major') : d.major ? c.red('major') : c.yellow('update');
        rows.push([d.alias ?? d.name, `${d.prefix ?? ''}${d.version}`, c.green(d.latest), `${mark} -> ${d.prefix ?? ''}${d.next}`]);
      } else {
        rows.push([d.alias ?? d.name, d.spec || '', '', c.dim(`${d.status}: ${d.reason}`)]);
      }
    }
    lines.push(table(rows));
  }
  const s = summarize(analysis);
  lines.push(
    '',
    `${analysis.files.length} manifest(s): ${c.yellow(`${s.outdated} outdated`)}, ${s.held} held back, ${c.green(`${s.current} up to date`)}, ${s.skipped} skipped, ${s.error} errors`,
  );
  return lines.join('\n');
}

/** Plain-data view for --json output and MCP responses. */
export function analysisToJSON(analysis) {
  return {
    summary: summarize(analysis),
    files: analysis.files.map((f) => ({
      path: f.relPath,
      ecosystem: f.ecosystem,
      dependencies: f.deps.map((d) => ({
        name: d.name,
        ...(d.alias ? { alias: d.alias } : {}),
        section: d.section,
        current: d.spec,
        latest: d.latest ?? null,
        next: d.next ? `${d.prefix ?? ''}${d.next}` : null,
        major: d.major ?? false,
        status: d.status,
        ...(d.reason ? { reason: d.reason } : {}),
      })),
    })),
  };
}

/** Compact text for agent context (hooks, MCP): only what needs attention. */
export function briefAnalysis(analysis, { limit = 25 } = {}) {
  const s = summarize(analysis);
  if (!s.outdated && !s.held) return `agent-versions: all ${s.current} checked dependencies are on the latest release.`;
  const out = [`agent-versions: ${s.outdated} dependencies have newer releases${s.held ? ` (+${s.held} major updates held back)` : ''}.`];
  let n = 0;
  for (const f of analysis.files) {
    for (const d of f.deps) {
      if (d.status !== 'outdated' && d.status !== 'held') continue;
      if (n++ >= limit) continue;
      out.push(`- ${f.relPath}: ${d.alias ?? d.name} ${d.prefix ?? ''}${d.version} -> ${d.latest}${d.major ? ' (major)' : ''}`);
    }
  }
  if (n > limit) out.push(`- ...and ${n - limit} more`);
  out.push('Run `npx -y github:AndrewTtofi/versions update` (add --no-major to skip breaking bumps), then reinstall.');
  return out.join('\n');
}
