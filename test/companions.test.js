import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COMPANIONS, detectCompanions, selectCompanions, setupCompanions } from '../src/companions.js';
import { makeProject } from './helpers.js';

const BLOCK = '<!-- agent-versions:start -->\n## Dependency versions\nLook it up.\n<!-- agent-versions:end -->\n';

test('detects companions from their config files', async () => {
  const dir = await makeProject({ '.cursor/x': '', '.kiro/x': '', 'GEMINI.md': '# g\n' });
  assert.deepEqual(detectCompanions(dir).map((c) => c.id), ['agents', 'gemini-cli', 'cursor', 'kiro']);
  assert.throws(() => selectCompanions(dir, 'cursor,nope'), /Unknown companion/);
  assert.equal(selectCompanions(dir, 'all').length, COMPANIONS.length);
});

test('--for all writes every rules file and MCP config, idempotently', async () => {
  const dir = await makeProject({ '.aider.conf.yml': 'model: x\n', '.clinerules': 'Be terse.\n', '.vscode/mcp.json': '// comment\n{}' });
  const all = selectCompanions(dir, 'all');
  const first = await setupCompanions(dir, all, { block: BLOCK, mcp: true });
  const second = await setupCompanions(dir, all, { block: BLOCK, mcp: true });
  assert.ok(second.every((l) => /^\s+(kept|note|manual)/.test(l)), second.join('\n'));
  assert.ok(first.some((l) => l.includes('manual') && l.includes('.vscode/mcp.json')), 'JSONC is never clobbered');
  assert.equal(await readFile(join(dir, '.vscode/mcp.json'), 'utf8'), '// comment\n{}');

  const mdc = await readFile(join(dir, '.cursor/rules/agent-versions.mdc'), 'utf8');
  assert.match(mdc, /^---\ndescription: .+\nalwaysApply: true\n---\n\n## Dependency versions/);
  assert.match(await readFile(join(dir, '.windsurf/rules/agent-versions.md'), 'utf8'), /^---\ntrigger: always_on\n---/);
  assert.match(await readFile(join(dir, '.github/instructions/agent-versions.instructions.md'), 'utf8'), /applyTo: "\*\*"/);
  assert.match(await readFile(join(dir, '.kiro/steering/agent-versions.md'), 'utf8'), /inclusion: always/);
  assert.match(await readFile(join(dir, '.clinerules'), 'utf8'), /^Be terse\.\n\n<!-- agent-versions:start -->/, 'legacy .clinerules file gets a block');
  assert.equal(await readFile(join(dir, '.aider.conf.yml'), 'utf8'), 'model: x\nread: [AGENTS.md]\n');

  const toml = await readFile(join(dir, '.codex/config.toml'), 'utf8');
  assert.equal(toml.match(/\[mcp_servers\.agent-versions\]/g).length, 1);
  const opencode = JSON.parse(await readFile(join(dir, 'opencode.json'), 'utf8'));
  assert.deepEqual(opencode.mcp['agent-versions'].command, ['npx', '-y', 'github:AndrewTtofi/versions', 'mcp']);
  const zed = JSON.parse(await readFile(join(dir, '.zed/settings.json'), 'utf8'));
  assert.equal(zed.context_servers['agent-versions'].source, 'custom');
  for (const p of ['.cursor/mcp.json', '.gemini/settings.json', '.kilocode/mcp.json', '.roo/mcp.json', '.kiro/settings/mcp.json', '.amazonq/mcp.json', '.mcp.json']) {
    assert.ok(JSON.parse(await readFile(join(dir, p), 'utf8')).mcpServers['agent-versions'], p);
  }
  assert.match(await readFile(join(dir, '.continue/mcpServers/agent-versions.yaml'), 'utf8'), /schema: v1/);
});

test('existing JSON configs keep their other servers', async () => {
  const dir = await makeProject({ '.cursor/mcp.json': JSON.stringify({ mcpServers: { other: { command: 'x' } } }) });
  await setupCompanions(dir, selectCompanions(dir, 'cursor'), { block: BLOCK, mcp: true });
  const cfg = JSON.parse(await readFile(join(dir, '.cursor/mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(cfg.mcpServers), ['other', 'agent-versions']);
});
