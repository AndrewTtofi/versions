import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { analyze } from '../src/engine.js';
import { bumpLevel } from '../src/semver.js';
import { fakeResolve, makeProject } from './helpers.js';

const run = promisify(execFile);
const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const DAY = 86_400_000;

test('bumpLevel classifies updates', () => {
  assert.equal(bumpLevel('1.2.3', '1.2.4'), 'patch');
  assert.equal(bumpLevel('1.2.3', '1.3.0'), 'minor');
  assert.equal(bumpLevel('1.2.3', '2.0.0'), 'major');
  assert.equal(bumpLevel('0.3.1', '0.4.0'), 'major');
  assert.equal(bumpLevel('0.3.1', '0.3.2'), 'minor');
  assert.equal(bumpLevel('v1.8.0', 'v1.8.1'), 'patch');
});

test('minimum release age holds fresh releases', async () => {
  const dir = await makeProject({ 'package.json': '{"dependencies":{"zod":"^3.0.0","react":"~19.0.0","typescript":"5.0.0"}}' });
  const now = Date.parse('2026-09-30T12:00:00Z');
  const published = { zod: now - 10 * DAY, react: now - 5 * 3600_000 }; // typescript: registry has no date
  const analysis = await analyze(dir, {
    resolve: fakeResolve,
    minAgeDays: 3,
    now,
    publishedAt: async (eco, name) => (published[name] ? new Date(published[name]).toISOString() : null),
  });
  const d = Object.fromEntries(analysis.files[0].deps.map((x) => [x.name, x]));
  assert.equal(d.zod.status, 'outdated');
  assert.equal(d.react.status, 'held');
  assert.match(d.react.reason, /released 5h ago \(minimum age 3d\)/);
  assert.equal(d.typescript.status, 'outdated', 'no date available -> not held');
});

test('action report exposes the largest change level', async () => {
  const dir = await makeProject({});
  const result = {
    summary: { outdated: 2, held: 1 },
    files: [{ path: 'package.json', dependencies: [
      { name: 'a', current: '^1.0.0', next: '^1.0.1', status: 'outdated', level: 'patch' },
      { name: 'b', current: '^1.0.0', next: '^1.2.0', status: 'outdated', level: 'minor' },
      { name: 'c', current: '^1.0.0', next: '^1.2.0', status: 'held', reason: 'released 2h ago (minimum age 3d)' },
    ] }],
  };
  await writeFile(join(dir, 'r.json'), JSON.stringify(result));
  const { stdout } = await run(process.execPath, [script('action-report.js'), join(dir, 'r.json')]);
  assert.match(stdout, /^outdated=2$/m);
  assert.match(stdout, /^level=minor$/m);
  assert.match(stdout, /^patch=1$/m);
  assert.match(stdout, /1 release\(s\) are newer than the minimum release age/);
});

test('lockfile refresh targets the nearest lockfile and never runs install scripts', async () => {
  const dir = await makeProject({
    'package.json': '{"name":"root","private":true,"workspaces":["pkgs/*"]}',
    'package-lock.json': '{}',
    'pkgs/a/package.json': '{"name":"a"}',
  });
  const result = { files: [{ path: 'pkgs/a/package.json', dependencies: [{ status: 'outdated' }] }, { path: 'x/package.json', dependencies: [{ status: 'current' }] }] };
  await writeFile(join(dir, 'r.json'), JSON.stringify(result));
  // Stub npm on PATH so the test is offline and we can see the exact invocation.
  const bin = await makeProject({ npm: '#!/bin/sh\n[ "$1" = "--version" ] && exit 0\necho "npm $* cwd=$(pwd) scripts=$npm_config_ignore_scripts" >> "$LOG"\n' });
  await run('chmod', ['+x', join(bin, 'npm')]);
  const log = join(dir, 'calls.log');
  await run(process.execPath, [script('refresh-lockfiles.js'), join(dir, 'r.json'), dir], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOG: log },
  });
  const calls = (await readFile(log, 'utf8')).trim().split('\n');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^npm install --package-lock-only --ignore-scripts --no-audit --no-fund cwd=\S+ scripts=true$/);
  assert.ok(calls[0].includes(`cwd=${dir}`) && !calls[0].includes('pkgs'), 'uses the workspace root lockfile');
});

test('init writes the auto-merge policy', async () => {
  const dir = await makeProject({ 'package.json': '{"scripts":{"test":"node --test"}}', 'package-lock.json': '{}', 'go.mod': 'module x\n' });
  const bin = fileURLToPath(new URL('../bin/agent-versions.js', import.meta.url));
  await run(process.execPath, [bin, 'init', dir, '--no-agents', '--automerge', 'patch', '--min-age', '7']);
  const wf = await readFile(join(dir, '.github/workflows/agent-versions.yml'), 'utf8');
  assert.match(wf, /AUTOMERGE: patch /);
  assert.match(wf, /VERIFY: 'npm ci && npm test && go test \.\/\.\.\.' /);
  assert.match(wf, /args: --min-age 7\n/);
  assert.doesNotMatch(wf, /__[A-Z]+__/, 'all placeholders filled');
  // The verify job must never get write access.
  const verifyJob = wf.slice(wf.indexOf('  verify:'), wf.indexOf('  automerge:'));
  assert.match(verifyJob, /permissions:\n\s+contents: read\n/);
  assert.doesNotMatch(verifyJob, /write|secrets\./);

  await assert.rejects(run(process.execPath, [bin, 'init', dir, '--no-agents', '--force', '--verify', "a\nb"]), /single line/);
});

test('auto-merge gate fails closed (runs the real script from the template)', async () => {
  const tpl = await readFile(fileURLToPath(new URL('../templates/workflow.yml', import.meta.url)), 'utf8');
  const lines = tpl.split('\n');
  const start = lines.findIndex((l) => l.includes('rank() {'));
  const gate = lines.slice(start, start + 3).map((l) => l.trim()).join('\n') + '\n  echo review; exit 0\nfi\necho merge\n';
  const decide = async (AUTOMERGE, LEVEL) =>
    (await run('bash', ['-c', gate], { env: { PATH: process.env.PATH, AUTOMERGE, LEVEL } })).stdout.trim();
  const cases = [
    ['minor', 'patch', 'merge'], ['minor', 'minor', 'merge'], ['minor', 'major', 'review'],
    ['minor', '', 'review'], ['patch', 'minor', 'review'], ['none', 'patch', 'review'],
    ['bogus', 'patch', 'review'], ['major', 'major', 'merge'], ['minor', 'none', 'merge'],
  ];
  for (const [policy, level, expected] of cases) assert.equal(await decide(policy, level), expected, `${policy}/${level || '(empty)'}`);
});
