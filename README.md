# agent-versions

**Dependabot for AI coding.** AI agents write dependency versions from
training data that is months old. agent-versions gives them, and you, the
real latest versions live from npm, PyPI, crates.io and the Go module proxy.
It also keeps a continuously refreshed snapshot of every package that
Claude Code, Codex, Gemini CLI and other AI coding tools depend on.

It ships in several forms, so it fits wherever you work:

| Use it as | What you get |
|---|---|
| **Claude Code plugin** | An MCP server, a skill that makes the agent look versions up before writing them, and a session-start summary of what's outdated in your project |
| **MCP server / connector** | `latest_versions`, `check_manifest`, `check_project`, `update_project`, `ai_tool_versions`, `tool_stack`. Works in Claude Code, Codex, Gemini CLI, Cursor, Windsurf, Copilot, Cline, Kiro, Zed, claude.ai and any MCP client |
| **Rules for every companion** | `init` writes the native rules file for 17 coding companions, so each agent looks versions up instead of guessing |
| **CLI** | `check`, `update`, `latest`, `tools`, `stack`, `init` |
| **GitHub Action** | Scheduled pull requests that bump dependencies to the latest releases |
| **Data feed** | [`data/latest.json`](data/latest.json) and [`VERSIONS.md`](VERSIONS.md), refreshed every 4 hours |

Supports `package.json` (including overrides and pnpm/bun catalogs),
`pyproject.toml` (PEP 621, dependency groups, uv, Poetry), `requirements*.txt`,
`Cargo.toml` (including workspaces) and `go.mod`. Zero dependencies. Node 20+.

---

## Quick start

```bash
# What's outdated in this project? (recursive, monorepo-friendly)
npx -y github:AndrewTtofi/versions check

# Upgrade everything, holding back breaking (major) upgrades
npx -y github:AndrewTtofi/versions update --no-major
npm install   # or pnpm/uv/cargo/go - lockfiles are yours to refresh

# Latest version of anything
npx -y github:AndrewTtofi/versions latest next pypi:fastapi cargo:tokio go:github.com/spf13/cobra

# Latest Claude Code / Codex / Gemini CLI / ... and how to install them
npx -y github:AndrewTtofi/versions tools

# Set a project up so it stays current (see below)
npx -y github:AndrewTtofi/versions init --no-major --mcp
```

`update` changes only the version text. It keeps your range style (`^`,
`~`, `>=`, `==`, `~=`), your precision (`tokio = "1"` stays at one component
until 2.0 exists), and all formatting and comments. It never downgrades. It
skips `workspace:`, `file:`, git, path and complex ranges, and tells you why.

## Keep every project current

Run `init` once in a project:

```bash
npx -y github:AndrewTtofi/versions init --no-major --mcp
```

It works out which coding companions the project uses and writes:

- **`.github/workflows/agent-versions.yml`**: every Monday it runs
  `update` and opens (or refreshes) one PR with a table of what changed, just like
  Dependabot. Enable *Settings → Actions → General → Allow GitHub Actions to
  create and approve pull requests*.
- **`AGENTS.md`** plus **each companion's own rules file**: a short rule telling the agent to
  look versions up instead of guessing, and how to upgrade (table below).
- **MCP configs** (with `--mcp`): connects the MCP server for everyone who opens the
  project, in every companion that supports project-level MCP. Existing files are merged,
  and files with comments are never overwritten; you get the snippet to paste instead.
- **`agent-versions.json`**: project config (see [Configuration](#configuration)).

Companions are detected from their config files. Use `--for cursor,windsurf`
to choose, `--for all` for every companion, or `--for list` to see them.

| Companion | Rules file | MCP config (`--mcp`) |
|---|---|---|
| Codex, Amp, Factory, Copilot CLI, opencode, Junie, … | `AGENTS.md` (always) | Codex: `.codex/config.toml`, opencode: `opencode.json` |
| Claude Code | `CLAUDE.md` | `.mcp.json` |
| Gemini CLI | `GEMINI.md` | `.gemini/settings.json` |
| Cursor | `.cursor/rules/agent-versions.mdc` | `.cursor/mcp.json` |
| Windsurf | `.windsurf/rules/agent-versions.md` | global only |
| GitHub Copilot (VS Code) | `.github/instructions/agent-versions.instructions.md` | `.vscode/mcp.json` |
| Cline | `.clinerules/agent-versions.md` | global only |
| Kilo Code / Roo Code | `.kilocode/rules/…` / `.roo/rules/…` | `.kilocode/mcp.json` / `.roo/mcp.json` |
| Continue | `.continue/rules/agent-versions.md` | `.continue/mcpServers/agent-versions.yaml` |
| JetBrains Junie | `.junie/guidelines.md` | — |
| Kiro / Amazon Q | `.kiro/steering/…` / `.amazonq/rules/…` | `.kiro/settings/mcp.json` / `.amazonq/mcp.json` |
| Zed | `.rules` (if present, else `AGENTS.md`) | `.zed/settings.json` |
| Aider | adds `read: [AGENTS.md]` to `.aider.conf.yml` | — |

## Claude Code plugin

```text
/plugin marketplace add AndrewTtofi/versions
/plugin install agent-versions@agent-versions
```

The plugin bundles:

- the **MCP server** (runs locally with `node`; nothing to install),
- a **`latest-versions` skill** that fires whenever the agent adds, pins or upgrades
  a dependency or writes install commands, and
- a **SessionStart hook** that puts a short list of outdated dependencies into the
  agent's context each time you open a project. Set `AGENT_VERSIONS_HOOK=off` to
  turn it off.

## MCP server (Codex, Gemini CLI, Cursor, Claude Code, ...)

The server runs over stdio: `npx -y github:AndrewTtofi/versions mcp`.

**Claude Code** (without the plugin)

```bash
claude mcp add agent-versions -- npx -y github:AndrewTtofi/versions mcp
```

**OpenAI Codex**: `~/.codex/config.toml`

```toml
[mcp_servers.agent-versions]
command = "npx"
args = ["-y", "github:AndrewTtofi/versions", "mcp"]
```

**Gemini CLI**: `~/.gemini/settings.json`. **Cursor**: `.cursor/mcp.json`. **VS Code**: `.vscode/mcp.json` (use `"servers"` there).

```json
{
  "mcpServers": {
    "agent-versions": { "command": "npx", "args": ["-y", "github:AndrewTtofi/versions", "mcp"] }
  }
}
```

### Tools

| Tool | Purpose |
|---|---|
| `latest_versions` | Live latest version of up to 100 packages (`zod`, `pypi:x`, `cargo:x`, `go:x`) |
| `check_manifest` | Send a manifest's text, get back what's outdated plus the fully updated file |
| `check_project` | Scan a local directory *(local only)* |
| `update_project` | Rewrite a local project's manifests *(local only)* |
| `ai_tool_versions` | Latest Claude Code, Codex, Gemini CLI, Copilot CLI, opencode, Aider, ... with install commands |
| `tool_stack` | Every dependency a given AI tool builds on, with latest versions |

### Remote connector (claude.ai, team-wide)

The same server speaks MCP Streamable HTTP. Remote mode leaves out the two
filesystem tools; the agent uses `check_manifest` instead.

```bash
npx -y github:AndrewTtofi/versions mcp --http --port 3000                 # 127.0.0.1 only
npx -y github:AndrewTtofi/versions mcp --http --host 0.0.0.0 --port 3000  # behind your reverse proxy
```

The connector enforces a per-client rate limit (`AGENT_VERSIONS_RATE_LIMIT`, default 120/min),
body and batch size caps, and an Origin allow-list (`AGENT_VERSIONS_ALLOWED_ORIGINS`).
Browsers are rejected unless their origin is listed. See [SECURITY.md](SECURITY.md).

Or deploy the repository as-is to a serverless host. `api/mcp.js` is a ready-made
function entry point (on Vercel: `vercel deploy`, endpoint `https://<app>/api/mcp`).
Then in claude.ai go to **Settings → Connectors → Add custom connector** and paste
the URL. The endpoint is read-only and stateless, and it needs no secrets.

## GitHub Action

```yaml
- uses: actions/checkout@v7
- uses: AndrewTtofi/versions@v0.2.0   # pin a release or commit SHA
  id: versions
  with:
    args: --no-major --exclude "eslint*"   # any CLI flags
    # mode: check                           # report only; fails the job when outdated
- uses: peter-evans/create-pull-request@v8
  with:
    title: 'chore(deps): update dependencies to latest releases'
    body: ${{ steps.versions.outputs.report }}
```

Outputs: `report` (a Markdown table) and `outdated` (a count).

## CLI reference

```text
agent-versions <command> [options]

  check [dir]       Report dependencies with newer releases (default command)
  update [dir]      Rewrite manifests to the latest releases
  latest <pkg...>   Latest version of packages
  tools             Latest versions of AI coding tools
  stack <tool>      Dependencies an AI tool uses, with latest versions
  init [dir]        Config + scheduled update PRs + agent instructions (--mcp, --no-workflow, --no-agents)
  mcp               MCP server over stdio (--http [--port N] for remote)

  --no-major        Hold back breaking upgrades (1.x→2.x, 0.3→0.4)
  --tracked [--tool <id>]  Only touch deps that tracked AI tools also use (optionally one tool)
  --snapshot        Use the published snapshot instead of live registries (fast, reproducible)
  --exclude a,b*    Leave packages alone          --peer / --indirect   Include peer deps / indirect Go deps
  --dry-run         Preview update                --fail               check exits 1 when outdated (CI)
  --brief | --json  Output formats                --no-recursive        Top-level manifests only
```

## Configuration

`agent-versions.json` in the project root. CLI flags override it.

```json
{
  "noMajor": true,
  "exclude": ["react", "react-dom", "@types/*"],
  "include": [],
  "includePeer": false,
  "includeIndirect": false,
  "tracked": false,
  "source": "live"
}
```

Environment: `AGENT_VERSIONS_NPM_REGISTRY`, `AGENT_VERSIONS_PYPI`,
`AGENT_VERSIONS_CRATES_INDEX`, `GOPROXY` (mirrors and private registries),
`AGENT_VERSIONS_SNAPSHOT_URL` (your own fork's feed), and `AGENT_VERSIONS_HOOK=off`.

## How the feed stays fresh

[`.github/workflows/update-snapshot`](.github/workflows/update.yml) runs every 4 hours.
For every tool in [`sources.json`](sources.json) it:

1. resolves the tool's own latest versions (npm, PyPI, GitHub releases),
2. finds every manifest in its public repositories, skipping tests, examples, docs
   and vendored code, or reads the published package's dependencies for closed-source tools,
3. drops the repository's own internal packages, then resolves the latest release of every remaining dependency,
4. commits `data/latest.json` and `VERSIONS.md` if anything changed.

The CLI and MCP tools query registries **live** by default, so they are never
more out of date than the registries themselves. The snapshot powers `tools`,
`stack`, `--tracked` and `--snapshot`, and serves as an offline fallback.

Tracked today (29): Claude Code & Claude Agent SDK, OpenAI Codex, Gemini CLI,
GitHub Copilot CLI, GitHub Copilot Chat, Cursor, opencode, Qwen Code, Crush, goose,
Aider, Cline, Continue, OpenHands, Kilo Code, Amp, Augment (Auggie), Factory Droid,
JetBrains Junie, CodeBuddy, Letta Code, Mistral Vibe, Grok CLI, Zed, gptme, SWE-agent,
and the MCP, OpenAI Agents and Agent Client Protocol SDKs. Closed-source tools are tracked
through their published packages or update feeds.
To add a tool, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Programmatic use

```js
import { analyze, applyUpdates, createResolver } from 'agent-versions';

const analysis = await analyze('.', { noMajor: true });
await applyUpdates(analysis);
```

## Security

agent-versions is a supply-chain component, so it's built defensively:

- It never writes a version that fails strict validation.
- It never builds a registry URL from an unvalidated name.
- Local MCP tools can't leave the project directory.
- The public connector is read-only and rate-limited.
- The repository runs SHA-pinned, least-privilege workflows behind a protected `main`.

Details and reporting are in [SECURITY.md](SECURITY.md).

## Contributing

PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). If you're working with an AI agent,
it should read [CLAUDE.md](CLAUDE.md). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)
