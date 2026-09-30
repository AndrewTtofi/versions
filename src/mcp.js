// Dependency-free Model Context Protocol server.
//   stdio: used by the Claude Code plugin, Codex, Gemini CLI, Cursor, ...
//   http:  stateless Streamable HTTP endpoint (POST /mcp) for remote
//          connectors such as claude.ai custom connectors.

import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { resolve as resolvePath } from 'node:path';
import { analyze, analyzeManifestText, applyUpdates } from './engine.js';
import { analysisToJSON, briefAnalysis, parsePackageRef } from './report.js';
import { createResolver } from './registries.js';
import { loadSnapshot } from './snapshot.js';
import { VERSION } from './version.js';

const SERVER_INFO = { name: 'agent-versions', title: 'Agent Versions', version: VERSION };
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Use these tools whenever you add, install, upgrade or pin a dependency, scaffold a project, or write install commands.
Your training data is out of date: never guess a package version from memory - call latest_versions first.
Before editing an existing project's dependencies, call check_project (local) or check_manifest (remote) to see what is outdated.`;

const commonOptions = {
  no_major: { type: 'boolean', description: 'Hold back breaking (major) upgrades.' },
  exclude: { type: 'array', items: { type: 'string' }, description: 'Package names/globs to leave untouched.' },
};

const TOOLS = [
  {
    name: 'latest_versions',
    title: 'Latest package versions',
    description:
      'Get the latest published version of packages, live from npm, PyPI, crates.io and the Go module proxy. Use this before writing any version number. Refs look like "zod", "npm:zod", "pypi:requests", "cargo:serde", "go:github.com/spf13/cobra".',
    inputSchema: {
      type: 'object',
      properties: { packages: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 } },
      required: ['packages'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    remote: true,
  },
  {
    name: 'ai_tool_versions',
    title: 'AI coding tool versions',
    description:
      'Latest versions and install commands for AI coding tools and SDKs (Claude Code, Codex, Gemini CLI, Copilot CLI, opencode, Aider, MCP SDKs, ...).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
    remote: true,
  },
  {
    name: 'tool_stack',
    title: 'Dependency stack of an AI tool',
    description:
      'List the dependencies an AI coding tool uses, each with its latest version (e.g. what Codex or Gemini CLI builds on). Filter by ecosystem or name substring.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Tool id, e.g. claude-code, codex, gemini-cli. Omit to list tool ids.' },
        ecosystem: { type: 'string', enum: ['npm', 'pypi', 'cargo', 'go'] },
        query: { type: 'string', description: 'Only packages whose name contains this.' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    remote: true,
  },
  {
    name: 'check_manifest',
    title: 'Check a manifest',
    description:
      'Check the contents of a package.json, pyproject.toml, requirements*.txt, Cargo.toml or go.mod against the latest releases. Returns what is outdated and the full updated file content (formatting preserved).',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'File name, e.g. package.json' },
        content: { type: 'string', description: 'Full text of the manifest' },
        ...commonOptions,
      },
      required: ['filename', 'content'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    remote: true,
  },
  {
    name: 'check_project',
    title: 'Check a local project',
    description: 'Scan a local project directory (recursively) for manifests and report dependencies with newer releases.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Project directory. Defaults to the working directory.' }, ...commonOptions },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'update_project',
    title: 'Update a local project',
    description:
      'Rewrite manifests in a local project to the latest releases, preserving range operators and formatting. Lockfiles are not touched: run the package manager install afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project directory. Defaults to the working directory.' },
        dry_run: { type: 'boolean' },
        ...commonOptions,
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(typeof value === 'object' ? { structuredContent: value } : {}),
});

export function createHandlers({ remote = false, cwd = process.cwd() } = {}) {
  const resolve = createResolver();
  const opts = (args) => ({ resolve, noMajor: !!args.no_major, exclude: args.exclude ?? [] });

  const handlers = {
    async latest_versions({ packages }) {
      const results = {};
      await Promise.all(
        packages.map(async (ref) => {
          const [eco, name] = parsePackageRef(ref);
          try {
            results[`${eco}:${name}`] = (await resolve(eco, name)) ?? 'not found';
          } catch (err) {
            results[`${eco}:${name}`] = `error: ${err.message}`;
          }
        }),
      );
      return text({ versions: results });
    },
    async ai_tool_versions() {
      const snap = await loadSnapshot();
      const tools = {};
      for (const [id, t] of Object.entries(snap.tools)) {
        const pkgs = { ...t.packages };
        // Prefer live registry values over the snapshot for the tools themselves.
        for (const [eco, entries] of Object.entries(pkgs)) {
          pkgs[eco] = Object.fromEntries(
            await Promise.all(Object.entries(entries).map(async ([n, v]) => [n, (await resolve(eco, n).catch(() => null)) ?? v])),
          );
        }
        tools[id] = { name: t.name, packages: pkgs, ...(t.release ? { release: t.release } : {}), install: t.install, homepage: t.homepage };
      }
      return text({ snapshotGeneratedAt: snap.generatedAt, tools });
    },
    async tool_stack({ tool, ecosystem, query }) {
      const snap = await loadSnapshot();
      if (!tool || !snap.tools[tool]) {
        return text({ error: tool ? `Unknown tool "${tool}"` : 'Pass a tool id', tools: Object.keys(snap.tools) });
      }
      const out = {};
      for (const [eco, pkgs] of Object.entries(snap.packages)) {
        if (ecosystem && eco !== ecosystem) continue;
        for (const [name, p] of Object.entries(pkgs)) {
          if (!p.usedBy.includes(tool) || (query && !name.toLowerCase().includes(query.toLowerCase()))) continue;
          (out[eco] ??= {})[name] = p.latest;
        }
      }
      return text({ tool, snapshotGeneratedAt: snap.generatedAt, packages: out });
    },
    async check_manifest(args) {
      const { file, updatedText } = await analyzeManifestText(args.filename, args.content, opts(args));
      const report = analysisToJSON({ files: [file] });
      return text({ ...report, updatedContent: updatedText === args.content ? null : updatedText });
    },
    async check_project(args) {
      const analysis = await analyze(resolvePath(cwd, args.path ?? '.'), opts(args));
      return text(briefAnalysis(analysis, { limit: 200 }) + '\n\n' + JSON.stringify(analysisToJSON(analysis).summary));
    },
    async update_project(args) {
      const analysis = await analyze(resolvePath(cwd, args.path ?? '.'), opts(args));
      const n = args.dry_run ? 0 : await applyUpdates(analysis);
      const brief = briefAnalysis(analysis, { limit: 200 });
      return text(args.dry_run ? `Dry run - nothing written.\n${brief}` : `Updated ${n} dependency version(s).\n${brief}\nNow run the package manager's install to refresh lockfiles.`);
    },
  };
  const tools = TOOLS.filter((t) => !remote || t.remote).map(({ remote: _, ...t }) => t);
  return { tools, handlers };
}

export function createMcp(options) {
  const { tools, handlers } = createHandlers(options);
  return async function handle(msg) {
    const { id, method, params = {} } = msg;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
    if (msg.jsonrpc !== '2.0' || typeof method !== 'string') return fail(-32600, 'Invalid Request');
    const isNotification = id === undefined;
    try {
      switch (method) {
        case 'initialize': {
          const requested = params.protocolVersion;
          return reply({
            protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          });
        }
        case 'ping':
          return reply({});
        case 'tools/list':
          return reply({ tools });
        case 'tools/call': {
          const handler = handlers[params.name];
          if (!handler || !tools.some((t) => t.name === params.name)) return fail(-32602, `Unknown tool: ${params.name}`);
          try {
            return reply(await handler(params.arguments ?? {}));
          } catch (err) {
            return reply({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
          }
        }
        default:
          if (isNotification) return null;
          return fail(-32601, `Method not found: ${method}`);
      }
    } catch (err) {
      return isNotification ? null : fail(-32603, err.message);
    }
  };
}

export function serveStdio(options) {
  const handle = createMcp(options);
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    const batch = Array.isArray(msg);
    const responses = (await Promise.all((batch ? msg : [msg]).map(handle))).filter(Boolean);
    if (responses.length) process.stdout.write(JSON.stringify(batch ? responses : responses[0]) + '\n');
  });
}

/** Node request handler for the stateless Streamable HTTP transport. */
export function createHttpHandler(options = {}) {
  const handle = createMcp({ remote: true, ...options });
  return async function (req, res) {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, mcp-protocol-version, mcp-session-id, authorization');
    res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    if (req.method === 'GET' && (path === '/' || path === '/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, server: SERVER_INFO, mcp: '/mcp' }));
    }
    if (path !== '/mcp' && path !== '/api/mcp') return res.writeHead(404).end();
    if (req.method !== 'POST') return res.writeHead(405, { allow: 'POST' }).end();

    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 2_000_000) return res.writeHead(413).end();
    }
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    }
    const batch = Array.isArray(msg);
    const responses = (await Promise.all((batch ? msg : [msg]).map(handle))).filter(Boolean);
    if (!responses.length) return res.writeHead(202).end();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(batch ? responses : responses[0]));
  };
}

export function serveHttp({ port = 3000, host = '0.0.0.0', ...options } = {}) {
  const server = createServer(createHttpHandler(options));
  server.listen(port, host, () => console.error(`agent-versions MCP server listening on http://${host}:${port}/mcp`));
  return server;
}
