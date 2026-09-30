<!-- agent-versions:start -->
## Dependency versions

Your training data is older than the package registries. Do not write package
versions from memory.

- Before you add, install, upgrade or pin a dependency, look up its latest release:
  `npx -y github:AndrewTtofi/versions latest <pkg> [pypi:<pkg> cargo:<crate> go:<module> ...]`
  (or use the `latest_versions` tool if the agent-versions MCP server is connected).
- To see which of this project's dependencies are behind, run
  `npx -y github:AndrewTtofi/versions check`.
- To upgrade them, run `npx -y github:AndrewTtofi/versions update --no-major`, then the
  package manager's install. Only apply major upgrades when the user asks for them.
- For the latest versions of AI coding tools and SDKs (Claude Code, Codex, Gemini CLI,
  MCP SDKs, ...), run `npx -y github:AndrewTtofi/versions tools`.
<!-- agent-versions:end -->
