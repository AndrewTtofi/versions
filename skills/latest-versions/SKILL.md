---
name: latest-versions
description: Use whenever you add, install, upgrade, pin or write the version of any npm, PyPI, Cargo or Go dependency or container image, scaffold a new project, write install commands or Dockerfiles, or when the user asks to update, bump or check dependencies or asks for the latest version of a package or AI tool (Claude Code, Codex, Gemini CLI, MCP SDK, ...). Your remembered versions are stale; this looks them up live.
---

# Latest versions

Package versions in your training data are months out of date. Treat any
version number you remember as wrong until you have checked it.

## Adding or pinning a dependency

1. Look up the current release before you write it anywhere (manifest, install
   command, Dockerfile, docs):
   - MCP tool `latest_versions` with refs such as `zod`, `pypi:fastapi`,
     `cargo:tokio`, `go:github.com/spf13/cobra`, `docker:node:22-alpine` (finds the newest
     tag of that variant), or
   - `node "${CLAUDE_PLUGIN_ROOT}/bin/agent-versions.js" latest zod pypi:fastapi`
2. Write that version, using the project's range style. Look at the other entries:
   `^1.2.3` in package.json, `>=1.2.3` or `==1.2.3` in Python, `"1.2"` in Cargo.
3. Install with the project's package manager so the lockfile agrees.

## Updating an existing project

1. Run `check_project` (MCP) or `node "${CLAUDE_PLUGIN_ROOT}/bin/agent-versions.js" check`
   and show the user what is outdated. Call out **major** updates, because they can break things.
2. Apply the updates with `update_project` (pass `no_major: true` unless the user asked for
   major upgrades) or `agent-versions update --no-major`.
3. Run the install (`npm install`, `pnpm install`, `uv lock`, `cargo update`,
   `go mod tidy`, ...) and then the tests. If a major bump breaks the build, read
   that package's changelog or migration guide before you change code.

## AI tool and SDK versions

For the latest Claude Code, Codex, Gemini CLI, Copilot CLI, opencode, Aider,
MCP SDK or Agents SDK versions, use `ai_tool_versions`. To see what one of those
tools builds on, use `tool_stack` (for example `tool: "codex"`).
