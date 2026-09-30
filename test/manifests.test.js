import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest } from '../src/manifests/index.js';

const byName = (deps) => Object.fromEntries(deps.map((d) => [d.alias ?? d.name, d]));
const at = (text, d) => text.slice(d.start, d.end);

test('package.json sections, ranges and skips', () => {
  const text = `{
  "name": "demo",
  "version": "1.0.0",
  "dependencies": { "zod": "^3.22.4", "react": "~18.2.0", "local": "workspace:*", "gh": "github:a/b" },
  "devDependencies": { "typescript": "5.4.5", "vite": ">=5 <7" },
  "peerDependencies": { "react": "^18.0.0" },
  "overrides": { "qs@<6.16.0": "6.16.0" }
}`;
  const { ecosystem, deps } = parseManifest('package.json', text);
  assert.equal(ecosystem, 'npm');
  const d = byName(deps);
  assert.equal(d.zod.prefix, '^');
  assert.equal(at(text, d.zod), '3.22.4');
  assert.equal(at(text, d.typescript), '5.4.5');
  assert.equal(d.local.skip, 'not a registry version');
  assert.equal(d.gh.skip, 'not a registry version');
  assert.equal(d.vite.skip, 'complex range');
  assert.equal(d.qs.version, '6.16.0');
  const reacts = deps.filter((x) => x.name === 'react');
  assert.deepEqual(reacts.map((r) => r.section).sort(), ['dependencies', 'peerDependencies']);
  assert.notEqual(reacts[0].start, reacts[1].start);
});

test('package.json catalogs', () => {
  const text = '{"workspaces":{"packages":["a/*"],"catalog":{"zod":"3.0.0"}}}';
  const { deps } = parseManifest('package.json', text);
  assert.equal(deps[0].section, 'catalog');
  assert.equal(at(text, deps[0]), '3.0.0');
});

test('requirements.txt', () => {
  const text = [
    '# comment',
    'requests==2.31.0  # pinned',
    'fastapi[all]>=0.100.0 ; python_version >= "3.9"',
    'pydantic~=2.5',
    'httpx>=0.25,<1',
    'rich',
    '-r other.txt',
    'git+https://github.com/x/y.git',
    'ruff==0.1.0 \\',
    '    --hash=sha256:abc',
  ].join('\n');
  const d = byName(parseManifest('requirements.txt', text).deps);
  assert.equal(at(text, d.requests), '2.31.0');
  assert.equal(at(text, d.fastapi), '0.100.0');
  assert.equal(d.pydantic.prefix, '~=');
  assert.equal(d.httpx.skip, 'complex range');
  assert.equal(d.rich.skip, 'unpinned');
  assert.equal(at(text, d.ruff), '0.1.0');
  assert.equal(Object.keys(d).length, 6);
});

test('pyproject.toml: PEP 621, groups, build-system, poetry', () => {
  const text = `[build-system]
requires = ["hatchling>=1.20"]

[project]
name = "demo"
dependencies = [
  "requests>=2.31.0",  # comment
  'httpx==0.27.0',
]

[project.optional-dependencies]
dev = ["ruff==0.4.0"]

[dependency-groups]
test = ["pydantic>=2.5.0"]

[tool.poetry.dependencies]
python = "^3.10"
fastapi = "^0.110.0"
rich = { version = "^13.0", extras = ["jupyter"] }
local = { path = "../local" }
`;
  const d = byName(parseManifest('pyproject.toml', text).deps);
  assert.equal(at(text, d.hatchling), '1.20');
  assert.equal(at(text, d.requests), '2.31.0');
  assert.equal(at(text, d.httpx), '0.27.0');
  assert.equal(at(text, d.ruff), '0.4.0');
  assert.equal(at(text, d.pydantic), '2.5.0');
  assert.equal(at(text, d.fastapi), '0.110.0');
  assert.equal(d.fastapi.prefix, '^');
  assert.equal(at(text, d.rich), '13.0');
  assert.equal(d.local.skip, 'not a registry version');
  assert.equal(d.python, undefined);
});

test('Cargo.toml tables, inline tables, renames and workspace refs', () => {
  const text = `[package]
name = "demo"
version = "0.1.0"

[dependencies]
serde = { version = "1.0.190", features = ["derive"] }
tokio = "1.35"
internal = { path = "../internal" }
shared = { workspace = true }
rng = { package = "rand", version = "0.8.5" }

[target.'cfg(unix)'.dev-dependencies]
clap = "=4.4.0"

[dependencies.toml]
version = "0.8.0"
default-features = false

[workspace.dependencies]
anyhow = "*"
`;
  const d = byName(parseManifest('Cargo.toml', text).deps);
  assert.equal(at(text, d.serde), '1.0.190');
  assert.equal(at(text, d.tokio), '1.35');
  assert.equal(d.internal.skip, 'not a registry version');
  assert.equal(d.shared, undefined);
  assert.equal(d.rng.name, 'rand');
  assert.equal(at(text, d.rng), '0.8.5');
  assert.equal(d.clap.prefix, '=');
  assert.equal(at(text, d.toml), '0.8.0');
  assert.equal(d.anyhow.skip, 'complex range');
});

test('go.mod require forms', () => {
  const text = `module example.com/demo

go 1.22

require github.com/pkg/errors v0.8.0

require (
	github.com/spf13/cobra v1.8.0
	golang.org/x/sync v0.5.0 // indirect
	example.com/fork v0.0.0-20240101010101-abcdefabcdef
)
`;
  const d = byName(parseManifest('go.mod', text).deps);
  assert.equal(at(text, d['github.com/pkg/errors']), 'v0.8.0');
  assert.equal(at(text, d['github.com/spf13/cobra']), 'v1.8.0');
  assert.equal(d['golang.org/x/sync'].section, 'indirect');
  assert.equal(d['example.com/fork'].skip, 'pseudo-version');
});
