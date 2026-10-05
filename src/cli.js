import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { analyze, applyUpdates, summarize } from './engine.js';
import { analysisToJSON, briefAnalysis, c, formatAnalysis, parsePackageRef } from './report.js';
import { COMPANIONS, selectCompanions, setupCompanions } from './companions.js';
import { createResolver } from './registries.js';
import { loadSnapshot, snapshotResolver, trackedSet } from './snapshot.js';
import { VERSION } from './version.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = 'agent-versions.json';

const HELP = `agent-versions ${VERSION} - keep dependencies on the latest releases, for humans and AI agents

Usage: agent-versions <command> [options]

Commands:
  check [dir]            Report dependencies with newer releases (default command)
  update [dir]           Rewrite manifests to the latest releases (keeps ^, ~, >= etc.)
  latest <pkg...>        Latest version of packages: zod npm:zod pypi:requests cargo:serde go:<module> docker:node:20-alpine
  tools                  Latest versions of AI coding tools (Claude Code, Codex, Gemini CLI, ...)
  stack <tool>           Dependencies an AI tool uses, with latest versions
  init [dir]             Set up a project: config, daily update PRs with safe auto-merge, rules
                         for every coding companion found (--for cursor,windsurf|all|list,
                         --mcp, --automerge none|patch|minor|major, --verify "<cmd>", --min-age N)
  mcp                    Run the MCP server over stdio (--http [--port N] [--host H] for connectors)

Options:
  --no-major             Hold back breaking (major) upgrades
  --tracked [tool]       Only touch dependencies that tracked AI tools also use
  --snapshot             Use the published snapshot instead of querying registries live
  --min-age <days>       Hold releases younger than this (supply-chain safety)
  --exclude <a,b>        Package names/globs to leave untouched
  --peer                 Include peerDependencies
  --indirect             Include indirect Go requirements
  --no-recursive         Only look at manifests in the top-level directory
  --dry-run              (update) Show changes without writing
  --brief                Compact output for agent context and hooks
  --fail                 (check) Exit with status 1 when something is outdated
  --json                 Machine-readable output
  -v, --verbose          Also list skipped dependencies
  -h, --help / --version

Supported manifests: package.json, pyproject.toml, requirements*.txt, Cargo.toml, go.mod
Config: ${CONFIG_FILE} in the project root, e.g. { "noMajor": true, "exclude": ["react*"] }
`;

const OPTIONS = {
  'no-major': { type: 'boolean' },
  tracked: { type: 'boolean' },
  snapshot: { type: 'boolean' },
  exclude: { type: 'string', multiple: true },
  peer: { type: 'boolean' },
  indirect: { type: 'boolean' },
  'no-recursive': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  brief: { type: 'boolean' },
  fail: { type: 'boolean' },
  json: { type: 'boolean' },
  verbose: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  http: { type: 'boolean' },
  port: { type: 'string' },
  tool: { type: 'string' },
  'no-workflow': { type: 'boolean' },
  'no-agents': { type: 'boolean' },
  mcp: { type: 'boolean' },
  for: { type: 'string' },
  'min-age': { type: 'string' },
  automerge: { type: 'string' },
  verify: { type: 'string' },
  host: { type: 'string' },
  force: { type: 'boolean' },
};

async function loadConfig(dir) {
  const path = join(dir, CONFIG_FILE);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Could not parse ${path}: ${err.message}`);
  }
}

async function buildOptions(dir, values) {
  const config = await loadConfig(dir);
  const split = (list) => (list ?? []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  const opts = {
    recursive: !(values['no-recursive'] ?? config.recursive === false),
    noMajor: values['no-major'] ?? config.noMajor ?? false,
    includePeer: values.peer ?? config.includePeer ?? false,
    includeIndirect: values.indirect ?? config.includeIndirect ?? false,
    exclude: [...(config.exclude ?? []), ...split(values.exclude)],
    include: config.include ?? [],
    minAgeDays: Number(values['min-age'] ?? config.minReleaseAgeDays ?? 0),
  };
  if (!Number.isFinite(opts.minAgeDays) || opts.minAgeDays < 0) throw new Error('--min-age must be a number of days');
  const useSnapshot = values.snapshot ?? config.source === 'snapshot';
  const tracked = values.tracked || values.tool ? values.tool ?? true : config.tracked;
  if (useSnapshot || tracked) {
    const snap = await loadSnapshot();
    if (useSnapshot) opts.resolve = snapshotResolver(snap);
    if (tracked) opts.tracked = trackedSet(snap, typeof tracked === 'string' ? tracked : undefined);
  }
  return opts;
}

async function cmdCheck(dir, values, { update = false } = {}) {
  const analysis = await analyze(dir, await buildOptions(dir, values));
  let written = 0;
  if (update && !values['dry-run']) written = await applyUpdates(analysis);

  if (values.json) {
    console.log(JSON.stringify({ ...analysisToJSON(analysis), ...(update ? { written } : {}) }, null, 2));
  } else if (values.brief) {
    console.log(briefAnalysis(analysis));
  } else {
    console.log(formatAnalysis(analysis, { verbose: values.verbose }));
    if (update) {
      console.log(
        values['dry-run']
          ? c.dim('\nDry run: nothing was written.')
          : written
            ? c.green(`\nUpdated ${written} version(s). Run your package manager's install to refresh lockfiles.`)
            : '\nNothing to update.',
      );
    } else if (summarize(analysis).outdated) {
      console.log(c.dim('\nRun `agent-versions update` to apply.'));
    }
  }
  if (!update && values.fail && summarize(analysis).outdated) process.exitCode = 1;
}

async function cmdLatest(refs, values) {
  if (!refs.length) throw new Error('Usage: agent-versions latest <pkg...>');
  const resolve = createResolver();
  const results = await Promise.all(
    refs.map(async (ref) => {
      const [eco, name] = parsePackageRef(ref);
      try {
        return { ecosystem: eco, name, latest: await resolve(eco, name) };
      } catch (err) {
        return { ecosystem: eco, name, latest: null, error: err.message };
      }
    }),
  );
  if (values.json) return console.log(JSON.stringify(results, null, 2));
  for (const r of results) {
    console.log(`${r.ecosystem}:${r.name} ${r.latest ? c.green(r.latest) : c.red(r.error ?? 'not found')}`);
  }
  if (results.some((r) => !r.latest)) process.exitCode = 1;
}

async function cmdTools(values) {
  const snap = await loadSnapshot();
  const resolve = values.snapshot ? snapshotResolver(snap) : createResolver();
  const rows = [];
  for (const [id, tool] of Object.entries(snap.tools)) {
    const packages = {};
    for (const [eco, entries] of Object.entries(tool.packages ?? {})) {
      for (const [name, v] of Object.entries(entries)) packages[`${eco}:${name}`] = (await resolve(eco, name).catch(() => null)) ?? v;
    }
    rows.push({ id, name: tool.name, packages, release: tool.release, install: tool.install });
  }
  if (values.json) return console.log(JSON.stringify(rows, null, 2));
  for (const r of rows) {
    console.log(c.bold(r.name) + c.dim(` (${r.id})`));
    for (const [p, v] of Object.entries(r.packages)) console.log(`  ${p} ${c.green(v ?? '?')}`);
    if (r.release) console.log(`  release ${c.green(r.release)}`);
    console.log(c.dim(`  $ ${r.install}`));
  }
}

async function cmdStack(tool, values) {
  const snap = await loadSnapshot();
  if (!tool || !snap.tools[tool]) {
    throw new Error(`${tool ? `Unknown tool "${tool}". ` : ''}Known tools: ${Object.keys(snap.tools).join(', ')}`);
  }
  const out = {};
  for (const [eco, pkgs] of Object.entries(snap.packages)) {
    for (const [name, p] of Object.entries(pkgs)) if (p.usedBy.includes(tool)) (out[eco] ??= {})[name] = p.latest;
  }
  if (values.json) return console.log(JSON.stringify(out, null, 2));
  console.log(c.dim(`Snapshot ${snap.generatedAt}`));
  for (const [eco, pkgs] of Object.entries(out)) {
    console.log('\n' + c.bold(`${eco} (${Object.keys(pkgs).length})`));
    for (const [name, v] of Object.entries(pkgs)) console.log(`  ${name} ${c.green(v)}`);
  }
}

async function writeIfAbsent(path, content, force, log) {
  await mkdir(dirname(path), { recursive: true });
  try {
    // 'wx' fails atomically if the file exists, so there's no check-then-write race.
    await writeFile(path, content, { flag: force ? 'w' : 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') return log(`  kept     ${path} (exists; --force to overwrite)`);
    throw err;
  }
  log(`  wrote    ${path}`);
}

/** Best-effort install+test command for the verify job (tools preinstalled on ubuntu-latest). */
async function detectVerify(dir) {
  const steps = [];
  const has = (f) => existsSync(join(dir, f));
  if (has('package.json')) {
    let test = '';
    try {
      test = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).scripts?.test ?? '';
    } catch {}
    const runsTests = test && !/no test specified/.test(test);
    if (has('pnpm-lock.yaml')) steps.push('corepack enable', 'pnpm install --frozen-lockfile', runsTests && 'pnpm test');
    else if (has('yarn.lock')) steps.push('corepack enable', 'yarn install --immutable', runsTests && 'yarn test');
    else if (has('package-lock.json')) steps.push('npm ci', runsTests && 'npm test');
    else if (!has('bun.lock') && !has('bun.lockb')) steps.push('npm install', runsTests && 'npm test');
  }
  if (has('Cargo.toml')) steps.push('cargo test');
  if (has('go.mod')) steps.push('go test ./...');
  if (has('uv.lock')) steps.push('pipx run uv sync --locked', 'pipx run uv run pytest');
  return steps.filter(Boolean).join(' && ');
}

async function cmdInit(dir, values) {
  const log = (m) => console.log(m);
  if (values.for === 'list') {
    for (const comp of COMPANIONS) console.log(`${comp.id.padEnd(12)} ${comp.name}${comp.detect ? c.dim(`  (detected by ${comp.detect.join(', ')})`) : ''}`);
    return;
  }
  const companions = selectCompanions(dir, values.for);
  console.log(c.bold(`Setting up agent-versions in ${dir}`));
  console.log(c.dim(`Companions: ${companions.map((x) => x.id).join(', ')}${values.for ? '' : ' (auto-detected; use --for <ids|all>)'}`));
  await writeIfAbsent(join(dir, CONFIG_FILE), JSON.stringify({ noMajor: !!values['no-major'], exclude: [] }, null, 2) + '\n', values.force, log);

  if (!values['no-workflow']) {
    const automerge = values.automerge ?? 'minor';
    if (!['none', 'patch', 'minor', 'major'].includes(automerge)) throw new Error('--automerge must be none, patch, minor or major');
    const minAge = values['min-age'] ?? '3';
    if (!/^\d{1,3}$/.test(minAge)) throw new Error('--min-age must be a whole number of days');
    const verify = values.verify ?? (await detectVerify(dir));
    if (/[\n\r]/.test(verify)) throw new Error('--verify must be a single line');
    const args = [values['no-major'] && '--no-major', minAge !== '0' && `--min-age ${minAge}`].filter(Boolean).join(' ') || "''";
    const workflow = (await readFile(join(ROOT, 'templates', 'workflow.yml'), 'utf8'))
      .replace('__ARGS__', args)
      .replace('__REF__', `v${VERSION}`)
      .replace('__AUTOMERGE__', automerge)
      .replace('__VERIFY__', `'${verify.replace(/'/g, "''")}'`);
    await writeIfAbsent(join(dir, '.github', 'workflows', 'agent-versions.yml'), workflow, values.force, log);
    console.log(c.dim(`  auto-merge: up to ${automerge} updates, releases older than ${minAge} day(s), verified by: ${verify || '(required status checks)'}`));
  }
  if (!values['no-agents']) {
    const block = await readFile(join(ROOT, 'templates', 'agents-snippet.md'), 'utf8');
    for (const line of await setupCompanions(dir, companions, { block, mcp: !!values.mcp })) log(line);
  }
  console.log(`\nNext: ${c.bold('agent-versions check')} to see what is outdated, ${c.bold('agent-versions update')} to apply.`);
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  if (values.version) return console.log(VERSION);
  const [command = 'check', ...rest] = positionals;
  if (values.help || command === 'help') return console.log(HELP);
  const dir = () => resolvePath(rest[0] ?? '.');

  switch (command) {
    case 'check':
      return cmdCheck(dir(), values);
    case 'update':
      return cmdCheck(dir(), values, { update: true });
    case 'latest':
      return cmdLatest(rest, values);
    case 'tools':
      return cmdTools(values);
    case 'stack':
      return cmdStack(rest[0], values);
    case 'init':
      return cmdInit(dir(), values);
    case 'mcp': {
      const { serveHttp, serveStdio } = await import('./mcp.js');
      if (values.http) return serveHttp({ port: Number(values.port ?? process.env.PORT ?? 3000), host: values.host ?? process.env.HOST ?? '127.0.0.1' });
      return serveStdio();
    }
    default:
      // `agent-versions ./some/dir` is shorthand for `check ./some/dir`.
      if (existsSync(command)) return cmdCheck(resolvePath(command), values);
      throw new Error(`Unknown command "${command}". Run agent-versions --help.`);
  }
}
