// Wiring agent-versions into each coding companion: the rules/instructions
// file it reads, and (optionally) its project-level MCP configuration.

import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const MCP_COMMAND = { command: 'npx', args: ['-y', 'github:AndrewTtofi/versions', 'mcp'] };
const DESCRIPTION = 'Look up latest package versions instead of guessing; keep dependencies current';

// rules.mode: 'block'  -> upsert a marked block into a shared file
//             'file'   -> own file with optional frontmatter
// mcp.kind:   how the MCP server entry is written (see writeMcp)
export const COMPANIONS = [
  {
    id: 'agents',
    name: 'AGENTS.md (Codex, Copilot, opencode, Amp, Factory, Zed, Junie, Kilo, Cursor, ...)',
    always: true,
    rules: { path: 'AGENTS.md', mode: 'block' },
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    detect: ['CLAUDE.md', '.claude', '.mcp.json'],
    rules: { path: 'CLAUDE.md', mode: 'block' },
    mcp: { path: '.mcp.json', kind: 'mcpServers' },
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    detect: ['.codex'],
    mcp: { path: '.codex/config.toml', kind: 'codex-toml' },
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    detect: ['GEMINI.md', '.gemini'],
    rules: { path: 'GEMINI.md', mode: 'block' },
    mcp: { path: '.gemini/settings.json', kind: 'mcpServers' },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    detect: ['.cursor', '.cursorrules'],
    rules: { path: '.cursor/rules/agent-versions.mdc', mode: 'file', frontmatter: `description: ${DESCRIPTION}\nalwaysApply: true` },
    mcp: { path: '.cursor/mcp.json', kind: 'mcpServers' },
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    detect: ['.windsurf', '.windsurfrules'],
    rules: { path: '.windsurf/rules/agent-versions.md', mode: 'file', frontmatter: 'trigger: always_on' },
    mcpHint: 'Windsurf reads MCP servers from ~/.codeium/windsurf/mcp_config.json (global only).',
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot (VS Code / Copilot CLI)',
    detect: ['.github/copilot-instructions.md', '.github/instructions', '.vscode'],
    rules: { path: '.github/instructions/agent-versions.instructions.md', mode: 'file', frontmatter: 'applyTo: "**"' },
    mcp: { path: '.vscode/mcp.json', kind: 'vscode' },
  },
  {
    id: 'cline',
    name: 'Cline',
    detect: ['.clinerules'],
    rules: { path: '.clinerules/agent-versions.md', mode: 'file', legacyFile: '.clinerules' },
    mcpHint: 'Cline keeps MCP servers in its global settings: MCP Servers -> Configure -> add the agent-versions entry.',
  },
  {
    id: 'kilo-code',
    name: 'Kilo Code',
    detect: ['.kilocode'],
    rules: { path: '.kilocode/rules/agent-versions.md', mode: 'file' },
    mcp: { path: '.kilocode/mcp.json', kind: 'mcpServers' },
  },
  {
    id: 'roo-code',
    name: 'Roo Code',
    detect: ['.roo', '.roorules'],
    rules: { path: '.roo/rules/agent-versions.md', mode: 'file' },
    mcp: { path: '.roo/mcp.json', kind: 'mcpServers' },
  },
  {
    id: 'continue',
    name: 'Continue',
    detect: ['.continue'],
    rules: { path: '.continue/rules/agent-versions.md', mode: 'file', frontmatter: `name: agent-versions\ndescription: ${DESCRIPTION}\nalwaysApply: true` },
    mcp: { path: '.continue/mcpServers/agent-versions.yaml', kind: 'continue-yaml' },
  },
  {
    id: 'junie',
    name: 'JetBrains Junie',
    detect: ['.junie'],
    rules: { path: '.junie/guidelines.md', mode: 'block' },
  },
  {
    id: 'kiro',
    name: 'Kiro',
    detect: ['.kiro'],
    rules: { path: '.kiro/steering/agent-versions.md', mode: 'file', frontmatter: 'inclusion: always' },
    mcp: { path: '.kiro/settings/mcp.json', kind: 'mcpServers' },
  },
  {
    id: 'amazon-q',
    name: 'Amazon Q Developer',
    detect: ['.amazonq'],
    rules: { path: '.amazonq/rules/agent-versions.md', mode: 'file' },
    mcp: { path: '.amazonq/mcp.json', kind: 'mcpServers' },
  },
  {
    id: 'zed',
    name: 'Zed',
    // Zed reads .rules if present, otherwise AGENTS.md / CLAUDE.md / GEMINI.md.
    detect: ['.zed', '.rules'],
    rules: { path: '.rules', mode: 'block', onlyIfExists: true },
    mcp: { path: '.zed/settings.json', kind: 'zed' },
  },
  {
    id: 'opencode',
    name: 'opencode',
    detect: ['opencode.json', '.opencode'],
    mcp: { path: 'opencode.json', kind: 'opencode' },
  },
  {
    id: 'aider',
    name: 'Aider',
    detect: ['.aider.conf.yml'],
    aider: true,
  },
];

export function detectCompanions(dir) {
  return COMPANIONS.filter((c) => c.always || c.detect?.some((p) => existsSync(join(dir, p))));
}

export function selectCompanions(dir, spec) {
  if (!spec) return detectCompanions(dir);
  if (spec === 'all') return COMPANIONS;
  const ids = spec.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !COMPANIONS.some((c) => c.id === id));
  if (unknown.length) throw new Error(`Unknown companion(s): ${unknown.join(', ')}. Known: ${COMPANIONS.map((c) => c.id).join(', ')}`);
  return COMPANIONS.filter((c) => c.always || ids.includes(c.id));
}

const BLOCK_RE = /<!-- agent-versions:start -->[\s\S]*?<!-- agent-versions:end -->\n?/;

async function upsertBlock(path, block) {
  const existing = existsSync(path) ? await readFile(path, 'utf8') : '';
  let next;
  if (BLOCK_RE.test(existing)) next = existing.replace(BLOCK_RE, block);
  else if (!existing) next = block;
  else next = existing.replace(/\n*$/, '\n\n') + block;
  if (next === existing) return 'kept';
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next);
  return existing ? 'updated' : 'wrote';
}

async function writeOwnFile(path, content) {
  const existing = existsSync(path) ? await readFile(path, 'utf8') : null;
  if (existing === content) return 'kept';
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return existing == null ? 'wrote' : 'updated';
}

async function updateJson(path, mutate) {
  let cfg = {};
  const existed = existsSync(path);
  if (existed) {
    try {
      cfg = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return 'manual'; // JSONC with comments etc. - never clobber it
    }
  }
  const before = JSON.stringify(cfg);
  mutate(cfg);
  if (JSON.stringify(cfg) === before) return 'kept';
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cfg, null, 2) + '\n');
  return existed ? 'updated' : 'wrote';
}

function mcpSnippet(kind) {
  const { command, args } = MCP_COMMAND;
  switch (kind) {
    case 'vscode':
      return { servers: { 'agent-versions': { type: 'stdio', command, args } } };
    case 'opencode':
      return { mcp: { 'agent-versions': { type: 'local', command: [command, ...args], enabled: true } } };
    case 'zed':
      return { context_servers: { 'agent-versions': { source: 'custom', command, args, env: {} } } };
    default:
      return { mcpServers: { 'agent-versions': { command, args } } };
  }
}

async function writeMcp(path, kind) {
  if (kind === 'codex-toml') {
    const existing = existsSync(path) ? await readFile(path, 'utf8') : '';
    if (/^\[mcp_servers\.["']?agent-versions["']?\]/m.test(existing)) return 'kept';
    const table = `[mcp_servers.agent-versions]\ncommand = "${MCP_COMMAND.command}"\nargs = [${MCP_COMMAND.args.map((a) => `"${a}"`).join(', ')}]\n`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, existing ? existing.replace(/\n*$/, '\n\n') + table : table);
    return existing ? 'updated' : 'wrote';
  }
  if (kind === 'continue-yaml') {
    const yaml = `name: agent-versions\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: agent-versions\n    command: ${MCP_COMMAND.command}\n    args:\n${MCP_COMMAND.args.map((a) => `      - "${a}"`).join('\n')}\n`;
    return writeOwnFile(path, yaml);
  }
  const [[key, entries]] = Object.entries(mcpSnippet(kind));
  return updateJson(path, (cfg) => {
    if (kind === 'opencode' && !cfg.$schema) cfg.$schema = 'https://opencode.ai/config.json';
    cfg[key] ??= {};
    cfg[key]['agent-versions'] = entries['agent-versions'];
  });
}

/**
 * Set up the selected companions in `dir`.
 * @returns {Promise<string[]>} log lines
 */
export async function setupCompanions(dir, companions, { block, mcp = false } = {}) {
  const lines = [];
  const log = (status, path, note = '') => lines.push(`  ${status.padEnd(8)} ${path}${note ? `  (${note})` : ''}`);
  const body = block.replace(/<!-- agent-versions:(start|end) -->\n?/g, '');

  for (const c of companions) {
    const r = c.rules;
    if (r) {
      const full = join(dir, r.path);
      if (r.onlyIfExists && !existsSync(full)) {
        // falls back to AGENTS.md, which is always written
      } else if (r.legacyFile && existsSync(join(dir, r.legacyFile)) && statSync(join(dir, r.legacyFile)).isFile()) {
        log(await upsertBlock(join(dir, r.legacyFile), block), r.legacyFile, c.name);
      } else if (r.mode === 'block') {
        log(await upsertBlock(full, block), r.path, c.name);
      } else {
        const front = r.frontmatter ? `---\n${r.frontmatter}\n---\n\n` : '';
        log(await writeOwnFile(full, front + body), r.path, c.name);
      }
    }
    if (c.aider) {
      const path = join(dir, '.aider.conf.yml');
      const conf = await readFile(path, 'utf8');
      if (/AGENTS\.md/.test(conf)) log('kept', '.aider.conf.yml', c.name);
      else if (/^read\s*:/m.test(conf)) log('manual', '.aider.conf.yml', 'add AGENTS.md to the existing `read:` list');
      else {
        await writeFile(path, conf.replace(/\n*$/, '\n') + 'read: [AGENTS.md]\n');
        log('updated', '.aider.conf.yml', c.name);
      }
    }
    if (mcp && c.mcp) {
      const status = await writeMcp(join(dir, c.mcp.path), c.mcp.kind);
      const note = status === 'manual' ? `has comments; add this yourself: ${JSON.stringify(mcpSnippet(c.mcp.kind))}` : `${c.name} MCP`;
      log(status, c.mcp.path, note);
    } else if (mcp && c.mcpHint) {
      log('note', c.name, c.mcpHint);
    }
  }
  return lines;
}
