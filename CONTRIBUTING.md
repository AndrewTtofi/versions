# Contributing

Thanks for helping keep agents on current versions. By taking part you agree to
the [Code of Conduct](CODE_OF_CONDUCT.md). Found a vulnerability? Follow
[SECURITY.md](SECURITY.md) and don't open an issue.

## How changes land

1. Fork the repo and create a branch. Keep each PR focused on one thing.
2. `npm test` must pass. Add tests for any behaviour change.
3. Open a PR and fill in the checklist. CI runs on Node 20, 22 and 24. The first time
   you contribute, a maintainer approves the workflow run before it starts.
4. A code owner reviews and merges. `main` is protected: no direct pushes, no
   force-pushes, and every change needs review plus green checks.

Coding with an AI agent? Point it at [CLAUDE.md](CLAUDE.md) (or
[AGENTS.md](AGENTS.md)). It contains the project map and the hard rules.

## Development

```bash
npm test                          # unit + integration tests (no network needed)
node bin/agent-versions.js check  # try the CLI on this repo or any path
npm run collect                   # rebuild data/latest.json + VERSIONS.md (network; set GITHUB_TOKEN)
npm run mcp:http                  # local remote-connector endpoint on :3000/mcp
```

The project has **zero runtime dependencies** on purpose. It runs through
`npx github:...` and as a Claude Code plugin with no install step, so please
keep it that way (CI enforces this). Node's standard library is enough.

## Security rules for contributions

- Anything written into a user's manifest must pass `src/validate.js`.
- Registry URLs are only built from validated names.
- The remote MCP mode (`remote: true`) exposes read-only tools only.
- Workflows: actions pinned to full commit SHAs, `permissions: {}` at the top with
  per-job grants, no `pull_request_target`, and inputs passed through `env:`.
- Never commit secrets. Push protection blocks known token formats.

## Supporting a new coding companion

Add an entry to `COMPANIONS` in `src/companions.js` with the files that
detect it, its rules file (`mode: 'file'` with optional frontmatter, or
`mode: 'block'` for a shared file) and its MCP config format. Then add it to
`test/companions.test.js`.

## Tracking a new tool

Add an entry to `sources.json`:

```jsonc
{
  "id": "my-agent",                        // stable, kebab-case
  "name": "My Agent",
  "homepage": "https://github.com/me/my-agent",
  "install": "npm install -g my-agent",
  "packages": { "npm": ["my-agent"] },     // the tool's own published packages
  "packageDeps": { "npm": ["my-agent"] },  // closed source? read deps from the published package instead
  "releases": "me/my-agent",               // optional: GitHub releases for non-registry tools
  "repos": [{ "repo": "me/my-agent", "exclude": "optional-regex-of-paths-to-skip" }]
}
```

Manifests in `repos` are found automatically: every `package.json`,
`pyproject.toml`, `requirements*.txt`, `Cargo.toml` and `go.mod` outside
test, example, docs and vendor directories. Run `npm run collect` and include
the regenerated data in your PR.

## Adding an ecosystem

1. Add a parser in `src/manifests/` that exports `ecosystem`, `matches(filename)`
   and `parse(text, filename)`. Each dependency needs `name`, `spec`, `section`,
   and either `skip` (a reason) or `prefix`, `version` and the `start`/`end`
   offsets of the version text. The offsets are what let updates keep the file's formatting.
2. Add a `latest<Ecosystem>` lookup in `src/registries.js` and register it in `LOOKUPS`.
3. Add tests in `test/manifests.test.js` and `test/engine.test.js`.
