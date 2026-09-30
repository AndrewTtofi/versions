# Contributing

Thanks for helping keep agents on current versions.

## Development

```bash
npm test                          # unit + integration tests (no network needed)
node bin/agent-versions.js check  # try the CLI on this repo or any path
npm run collect                   # rebuild data/latest.json + VERSIONS.md (network; set GITHUB_TOKEN)
npm run mcp:http                  # local remote-connector endpoint on :3000/mcp
```

The project has **zero runtime dependencies** on purpose. It runs through
`npx github:...` and as a Claude Code plugin with no install step, so please
keep it that way. Node's standard library is enough.

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
