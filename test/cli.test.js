import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { makeProject } from './helpers.js';

const run = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/agent-versions.js', import.meta.url));

test('init writes config, workflow and an idempotent AGENTS.md block', async () => {
  const dir = await makeProject({ 'AGENTS.md': '# Project rules\n\nBe nice.\n', 'CLAUDE.md': '# Claude\n' });
  await run(process.execPath, [bin, 'init', dir, '--no-major', '--mcp']);
  await run(process.execPath, [bin, 'init', dir, '--no-major', '--mcp']);

  const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
  assert.match(agents, /^# Project rules\n\nBe nice\.\n\n<!-- agent-versions:start -->/);
  assert.equal(agents.match(/agent-versions:start/g).length, 1);
  assert.match(await readFile(join(dir, 'CLAUDE.md'), 'utf8'), /agent-versions:start/);
  assert.match(await readFile(join(dir, '.github/workflows/agent-versions.yml'), 'utf8'), /args: --no-major/);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'agent-versions.json'), 'utf8')), { noMajor: true, exclude: [] });
  assert.ok(JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8')).mcpServers['agent-versions']);
});

test('check --snapshot works offline against the bundled snapshot', async () => {
  const dir = await makeProject({ 'package.json': '{"dependencies":{"zod":"^1.0.0","not-a-real-pkg-xyz":"1.0.0"}}' });
  const { stdout } = await run(process.execPath, [bin, 'check', dir, '--snapshot', '--json'], {
    env: { ...process.env, AGENT_VERSIONS_SNAPSHOT_URL: 'http://127.0.0.1:9/none' },
  });
  const result = JSON.parse(stdout);
  const zod = result.files[0].dependencies.find((d) => d.name === 'zod');
  assert.equal(zod.status, 'outdated');
  assert.equal(zod.major, true);
});

test('unknown flags fail with a clear message', async () => {
  await assert.rejects(run(process.execPath, [bin, 'check', '--bogus']), (err) => {
    assert.equal(err.code, 2);
    assert.match(err.stderr, /bogus/);
    return true;
  });
});
