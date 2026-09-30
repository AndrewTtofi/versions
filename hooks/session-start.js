#!/usr/bin/env node
// Claude Code SessionStart hook: puts a short "what's outdated" summary into
// the agent's context. Never blocks the session - any failure prints nothing.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from '../src/engine.js';
import { briefAnalysis } from '../src/report.js';

const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod'];

if (process.env.AGENT_VERSIONS_HOOK !== 'off' && MANIFESTS.some((f) => existsSync(join(dir, f)))) {
  const timer = setTimeout(() => process.exit(0), 20_000);
  try {
    const analysis = await analyze(dir, { recursive: false, noMajor: false });
    console.log(briefAnalysis(analysis, { limit: 15 }));
    console.log('Use the agent-versions MCP tools (latest_versions, check_project, update_project) for exact versions; never guess versions from memory.');
  } catch {}
  clearTimeout(timer);
}
