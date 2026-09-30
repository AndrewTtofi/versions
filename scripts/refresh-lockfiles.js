#!/usr/bin/env node
// Regenerates lockfiles next to the manifests that `agent-versions update`
// changed, so update PRs install cleanly. It runs in the job that holds a
// write token, so it never executes package code: install scripts are
// disabled, and only resolve/lock operations are used.
//
// Usage: refresh-lockfiles.js <agent-versions --json output> [projectRoot]

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const [resultFile, rootArg = '.'] = process.argv.slice(2);
const root = resolve(rootArg);
const result = JSON.parse(readFileSync(resultFile, 'utf8'));

const has = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
const SAFE_ENV = {
  ...process.env,
  npm_config_ignore_scripts: 'true',
  YARN_ENABLE_SCRIPTS: 'false',
  CI: 'true',
};

// Lockfile -> how to refresh it without running dependency code.
const LOCKS = [
  { file: 'package-lock.json', cmd: 'npm', args: ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'] },
  { file: 'npm-shrinkwrap.json', cmd: 'npm', args: ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'] },
  { file: 'pnpm-lock.yaml', cmd: 'corepack', args: ['pnpm', 'install', '--lockfile-only', '--ignore-scripts'] },
  { file: 'yarn.lock', cmd: 'corepack', args: ['yarn', 'install', '--mode=update-lockfile'], classicArgs: ['yarn', 'install', '--ignore-scripts', '--non-interactive'] },
  { file: 'bun.lock', cmd: 'bun', args: ['install', '--lockfile-only', '--ignore-scripts'] },
  { file: 'bun.lockb', cmd: 'bun', args: ['install', '--lockfile-only', '--ignore-scripts'] },
  { file: 'uv.lock', cmd: 'uv', args: ['lock', '--no-build'], fallback: { cmd: 'pipx', args: ['run', 'uv', 'lock', '--no-build'] } },
  { file: 'poetry.lock', cmd: 'poetry', args: ['lock'], fallback: { cmd: 'pipx', args: ['run', 'poetry', 'lock'] } },
  { file: 'Cargo.lock', cmd: 'cargo', args: ['update', '--workspace'] },
  { file: 'go.sum', cmd: 'go', args: ['mod', 'tidy'], manifest: 'go.mod' },
];

/** Nearest lockfile of each kind, walking up from `dir` to the project root. */
function locksFor(dir) {
  const found = [];
  const seenKinds = new Set();
  for (let d = dir; ; d = dirname(d)) {
    for (const lock of LOCKS) {
      if (seenKinds.has(lock.file)) continue;
      if (existsSync(join(d, lock.file)) || (lock.manifest && existsSync(join(d, lock.manifest)) && d === dir)) {
        seenKinds.add(lock.file);
        found.push({ ...lock, dir: d });
      }
    }
    if (d === root || relative(root, d).startsWith('..') || dirname(d) === d) break;
  }
  return found;
}

const jobs = new Map();
for (const file of result.files) {
  if (!file.dependencies.some((d) => d.status === 'outdated')) continue;
  for (const lock of locksFor(resolve(root, dirname(file.path)))) jobs.set(`${lock.dir}\0${lock.file}`, lock);
}

let failures = 0;
for (const lock of jobs.values()) {
  let { cmd, args } = lock;
  if (lock.file === 'yarn.lock' && !existsSync(join(lock.dir, '.yarnrc.yml'))) args = lock.classicArgs;
  if (!has(cmd) && lock.fallback && has(lock.fallback.cmd)) ({ cmd, args } = lock.fallback);
  const where = relative(root, join(lock.dir, lock.file)) || lock.file;
  if (!has(cmd)) {
    console.log(`skip  ${where}: ${cmd} is not installed`);
    continue;
  }
  console.log(`lock  ${where}: ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { cwd: lock.dir, env: SAFE_ENV, stdio: 'inherit', timeout: 10 * 60_000 });
  if (res.status !== 0) {
    failures++;
    console.log(`::warning::Could not refresh ${where} (exit ${res.status}). The PR will need a manual lockfile update.`);
  }
}
if (!jobs.size) console.log('No lockfiles to refresh.');
process.exitCode = failures ? 1 : 0;
