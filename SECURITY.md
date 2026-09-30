# Security policy

agent-versions edits dependency manifests and runs inside coding agents, CI
pipelines and a public MCP endpoint. That makes it a supply-chain component,
and we treat reports accordingly.

## Reporting a vulnerability

**Do not open a public issue.** Report privately through
[GitHub private vulnerability reporting](https://github.com/AndrewTtofi/versions/security/advisories/new).

Please include affected versions or commits, reproduction steps, and the impact
you see. You can expect an acknowledgement within **72 hours** and a fix or
mitigation plan within **14 days** for confirmed high-severity issues. We will
credit you in the advisory unless you prefer otherwise.

## Supported versions

Only the latest release and `main` receive security fixes.

## Threat model

| Asset | Threat | Mitigation |
|---|---|---|
| Users' manifests | A compromised registry, snapshot or MCP caller injects text (e.g. `1.0.0", "evil": "…`) | Every version must match a strict pattern before it is written (`src/validate.js`). Edits replace only the exact version span |
| Registry requests | Crafted package names (`../`, query strings) steer requests | Per-ecosystem name validation before any URL is built. Registry hosts are fixed |
| Local MCP tools | A prompt-injected agent points `update_project` at other directories | Local tools are confined to the server's working directory |
| Remote MCP endpoint | Abuse, amplification, DNS rebinding, CSRF | Read-only tools only. Binds to localhost by default. Origin allow-list, per-client rate limit, and caps on body, batch, package and manifest sizes. No secrets, no state |
| Published snapshot | A malicious manifest in a tracked repo poisons `data/latest.json` | Names are validated and release tags sanitised. The feed lives on a separate `data` branch, so automation never writes to `main`. The workflow never runs on forks |
| This repository | Malicious PRs, tag moves, stolen tokens | Protected `main` (PRs only, code-owner review, required CI, no force-push or deletion). Release tags are immutable. Actions pinned to commit SHAs. Least-privilege `GITHUB_TOKEN`. Fork PR workflows need approval. Secret scanning with push protection. Zero runtime dependencies |
| Auto-merged update PRs | A freshly published malicious release is merged automatically | Minimum release age (default 3 days). Size policy (majors need a human by default). Tests run in a separate job with a read-only token and no secrets. Lockfiles are refreshed with install scripts disabled |
| People running the code | Executing whatever is on `main` | Pin a release (see below) |

## Using agent-versions safely

- **Pin what you execute.** Prefer `npx -y github:AndrewTtofi/versions#v0.2.0` (or a
  commit SHA) over the moving `main`, and `uses: AndrewTtofi/versions@<sha>` in workflows.
  `init` already pins the Action to the release that generated it.
- **Auto-merge is a trade-off.** Keep `--min-age` at 3 days or more. Set `--automerge patch`
  for critical systems. The verify job still *executes* new package code (read-only
  token, no secrets), so if you share an Actions cache across workflows, prefer not to
  restore or save caches in that job.
- **Review update PRs** like any other dependency change. A new release of a
  dependency can itself be malicious; agent-versions tells you it exists, not that it is safe.
  `--no-major` and `exclude` narrow the blast radius.
- **Self-hosting the connector:** keep the default `127.0.0.1` bind unless you're behind
  a reverse proxy. Set `AGENT_VERSIONS_TRUST_PROXY=1` only when that proxy sets
  `X-Forwarded-For`, and list any browser origins in `AGENT_VERSIONS_ALLOWED_ORIGINS`.
- The SessionStart hook reads manifests in your project and queries public registries. It
  sends no project contents anywhere. Disable it with `AGENT_VERSIONS_HOOK=off`.
