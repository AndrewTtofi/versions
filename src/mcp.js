// Dependency-free Model Context Protocol server.
//   stdio: used by the Claude Code plugin, Codex, Gemini CLI, Cursor, ...
//   http:  stateless Streamable HTTP endpoint (POST /mcp) for remote
//          connectors such as claude.ai custom connectors.

import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { relative, resolve as resolvePath, isAbsolute } from 'node:path';
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
  min_age_days: { type: 'number', description: 'Hold releases published fewer than this many days ago.' },
};

const TOOLS = [
  {
    name: 'latest_versions',
    title: 'Latest package versions',
    description:
      'Get the latest published version of packages, live from npm, PyPI, crates.io, the Go module proxy and public container registries. Use this before writing any version number. Refs look like "zod", "npm:zod", "pypi:requests", "cargo:serde", "go:github.com/spf13/cobra", "docker:node:20-alpine" (an image tag finds the newest tag of the same variant).',
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
      'Check the contents of a package.json, pyproject.toml, requirements*.txt, Cargo.toml, go.mod, Dockerfile or compose.yaml against the latest releases. Returns what is outdated and the full updated file content (formatting preserved).',
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

export const LIMITS = { packages: 100, manifestBytes: 512 * 1024, manifestDeps: 1000, excludes: 100 };

function assertArgs(cond, message) {
  if (!cond) throw new Error(message);
}

export function createHandlers({ remote = false, cwd = process.cwd() } = {}) {
  const resolve = createResolver();
  const opts = (args) => {
    const exclude = args.exclude ?? [];
    assertArgs(Array.isArray(exclude) && exclude.length <= LIMITS.excludes && exclude.every((e) => typeof e === 'string' && e.length <= 214), 'exclude must be a list of package names');
    const minAgeDays = args.min_age_days ?? 0;
    assertArgs(typeof minAgeDays === 'number' && minAgeDays >= 0 && minAgeDays <= 365, 'min_age_days must be 0-365');
    return { resolve, noMajor: !!args.no_major, exclude, minAgeDays };
  };
  // Local tools only operate inside the directory the server was started in
  // (the project), so a prompt-injected agent can't touch other checkouts.
  const projectPath = (p = '.') => {
    assertArgs(typeof p === 'string', 'path must be a string');
    const full = resolvePath(cwd, p);
    const rel = relative(cwd, full);
    if (process.env.AGENT_VERSIONS_ALLOW_ANY_PATH !== '1' && (rel.startsWith('..') || isAbsolute(rel))) {
      throw new Error(`path must be inside the project directory (${cwd}); set AGENT_VERSIONS_ALLOW_ANY_PATH=1 to allow others`);
    }
    return full;
  };

  const handlers = {
    async latest_versions({ packages }) {
      assertArgs(Array.isArray(packages) && packages.length > 0 && packages.length <= LIMITS.packages, `packages must be a list of 1-${LIMITS.packages} package refs`);
      assertArgs(packages.every((p) => typeof p === 'string' && p.length <= 320), 'each package ref must be a string');
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
      if (typeof tool !== 'string' || !Object.hasOwn(snap.tools, tool)) {
        return text({ error: 'Unknown or missing tool id', tools: Object.keys(snap.tools) });
      }
      const out = {};
      for (const [eco, pkgs] of Object.entries(snap.packages)) {
        if (ecosystem && eco !== ecosystem) continue;
        for (const [name, p] of Object.entries(pkgs)) {
          if (!p.usedBy.includes(tool) || (typeof query === 'string' && !name.toLowerCase().includes(query.toLowerCase()))) continue;
          (out[eco] ??= {})[name] = p.latest;
        }
      }
      return text({ tool, snapshotGeneratedAt: snap.generatedAt, packages: out });
    },
    async check_manifest(args) {
      assertArgs(typeof args.filename === 'string' && typeof args.content === 'string', 'filename and content are required strings');
      assertArgs(Buffer.byteLength(args.content) <= LIMITS.manifestBytes, `content is larger than ${LIMITS.manifestBytes / 1024} KB`);
      const { file, updatedText } = await analyzeManifestText(args.filename, args.content, { ...opts(args), maxDeps: LIMITS.manifestDeps });
      const report = analysisToJSON({ files: [file] });
      return text({ ...report, updatedContent: updatedText === args.content ? null : updatedText });
    },
    async check_project(args) {
      const analysis = await analyze(projectPath(args.path), opts(args));
      return text(briefAnalysis(analysis, { limit: 200 }) + '\n\n' + JSON.stringify(analysisToJSON(analysis).summary));
    },
    async update_project(args) {
      const analysis = await analyze(projectPath(args.path), opts(args));
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
          if (!tools.some((t) => t.name === params.name)) return fail(-32602, 'Unknown tool');
          const handler = handlers[params.name];
          if (params.arguments != null && (typeof params.arguments !== 'object' || Array.isArray(params.arguments))) return fail(-32602, 'arguments must be an object');
          try {
            return reply(await handler(params.arguments ?? {}));
          } catch (err) {
            return reply({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
          }
        }
        default:
          if (isNotification) return null;
          return fail(-32601, 'Method not found');
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

function allowedOrigins() {
  return (process.env.AGENT_VERSIONS_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
}

/** Fixed-window per-client rate limiter. */
function createRateLimiter(limit, windowMs = 60_000) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (key) => {
    const n = (hits.get(key) ?? 0) + 1;
    hits.set(key, n);
    return n <= limit;
  };
}

/**
 * Node request handler for the stateless Streamable HTTP transport.
 * Remote mode only exposes read-only tools; on top of that it enforces a
 * body limit, a per-client rate limit, and an Origin allow-list (browsers
 * are rejected unless listed, which also defeats DNS rebinding).
 */
export function createHttpHandler(options = {}) {
  const handle = createMcp({ remote: true, ...options });
  const rateLimit = createRateLimiter(Number(process.env.AGENT_VERSIONS_RATE_LIMIT ?? 120));
  const trustProxy = process.env.AGENT_VERSIONS_TRUST_PROXY === '1';
  const MAX_BODY = 1024 * 1024;

  return async function (req, res) {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'no-store');
    const origin = req.headers.origin;
    const origins = allowedOrigins();
    if (origin) {
      if (!origins.includes(origin)) return res.writeHead(403).end('Origin not allowed');
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-headers', 'content-type, mcp-protocol-version, mcp-session-id, authorization');
      res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
    }
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    if (req.method === 'GET' && (path === '/' || path === '/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, server: SERVER_INFO, mcp: '/mcp' }));
    }
    if (path !== '/mcp' && path !== '/api/mcp') return res.writeHead(404).end();
    if (req.method !== 'POST') return res.writeHead(405, { allow: 'POST' }).end();

    const client = (trustProxy && String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
    if (!rateLimit(client)) return res.writeHead(429, { 'retry-after': '60' }).end('Too many requests');
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) return res.writeHead(415).end('Expected application/json');
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return res.writeHead(413).end();

    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) return res.writeHead(413).end();
    }
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    }
    const batch = Array.isArray(msg);
    if (batch && (msg.length === 0 || msg.length > 20)) return res.writeHead(400).end('Batch must hold 1-20 messages');
    const responses = (await Promise.all((batch ? msg : [msg]).map((m) => (m && typeof m === 'object' ? handle(m) : { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } })))).filter(Boolean);
    if (!responses.length) return res.writeHead(202).end();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(batch ? responses : responses[0]));
  };
}

/** Binds to localhost unless a host is given explicitly (e.g. 0.0.0.0 behind a proxy). */
export function serveHttp({ port = 3000, host = '127.0.0.1', ...options } = {}) {
  const server = createServer(createHttpHandler(options));
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  server.listen(port, host, () => console.error(`agent-versions MCP server listening on http://${host}:${port}/mcp`));
  return server;
}
