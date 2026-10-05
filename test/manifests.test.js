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

test('pyproject.toml: include-group entries and uv workspace sources are not packages', () => {
  const text = `[project]
name = "demo"
dependencies = ["mcp-types==0.1.0", "torch==2.4.0"]

[dependency-groups]
test = ["pytest>=8.0", { include-group = "format" }]
dev = [
  { include-group = "test" },
  "Example_Stories",
]

[tool.uv.sources]
mcp-types = { workspace = true }
example-stories = { path = "examples" }
torch = { index = "pytorch" }
`;
  const d = byName(parseManifest('pyproject.toml', text).deps);
  assert.equal(d.test, undefined);
  assert.equal(d.format, undefined);
  assert.equal(at(text, d.pytest), '8.0');
  assert.equal(d['mcp-types'].skip, 'not a registry version');
  assert.equal(d['mcp-types'].start, undefined);
  assert.equal(d.Example_Stories.skip, 'not a registry version');
  assert.equal(d.torch.skip, 'private registry');
  assert.equal(Object.keys(d).length, 4);
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

test('Dockerfile: FROM, stages, COPY --from and skips', () => {
  const text = `# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:20-alpine AS build
COPY --from=ghcr.io/astral-sh/uv:0.4.0 /uv /bin/
FROM build AS test
FROM python:3.12-slim-bookworm
COPY --from=build /app /app
from postgres:16.4
FROM scratch
FROM alpine
FROM ubuntu:latest
FROM node:22@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
FROM node:\${NODE_VERSION}
FROM registry.internal.corp/team/app:1.2.3
FROM debian:bookworm
FROM python:3.14.0a1
`;
  const { ecosystem, deps } = parseManifest('Dockerfile', text);
  assert.equal(ecosystem, 'docker');
  const d = Object.fromEntries(deps.map((x) => [x.spec, x]));
  assert.equal(at(text, d['node:20-alpine']), '20-alpine');
  assert.equal(d['node:20-alpine'].name, 'node');
  assert.equal(d['node:20-alpine'].lookupName, 'docker.io/library/node:x-alpine');
  assert.equal(d['node:20-alpine'].section, 'FROM');
  assert.equal(at(text, d['ghcr.io/astral-sh/uv:0.4.0']), '0.4.0');
  assert.equal(d['ghcr.io/astral-sh/uv:0.4.0'].lookupName, 'ghcr.io/astral-sh/uv:x.x.x');
  assert.equal(d['ghcr.io/astral-sh/uv:0.4.0'].section, 'COPY --from');
  assert.equal(d['python:3.12-slim-bookworm'].lookupName, 'docker.io/library/python:x.x-slim-bookworm');
  assert.equal(at(text, d['postgres:16.4']), '16.4');
  assert.equal(d.alpine.skip, 'unpinned');
  assert.equal(d['ubuntu:latest'].skip, 'unpinned');
  assert.match(Object.keys(d).find((k) => k.includes('@sha256')), /^node:22@/);
  assert.equal(deps.find((x) => x.spec.includes('@sha256')).skip, 'pinned to a digest');
  assert.equal(d['node:${NODE_VERSION}'].skip, 'variable');
  assert.equal(d['registry.internal.corp/team/app:1.2.3'].skip, 'private registry');
  assert.equal(d['debian:bookworm'].skip, 'not a version tag');
  assert.equal(d['python:3.14.0a1'].skip, 'not a version tag');
  assert.equal(d.build, undefined, 'build stages are not images');
  assert.equal(d.scratch, undefined);
  assert.equal(deps.length, 11);
});

test('Compose files and Dockerfile name variants', () => {
  const text = `services:
  db:
    image: "postgres:16-alpine"  # pinned
  cache:
    image: redis:7.2
  app:
    build: .
    image: \${REGISTRY}/app:dev
`;
  const d = byName(parseManifest('compose.yaml', text).deps);
  assert.equal(at(text, d.postgres), '16-alpine');
  assert.equal(at(text, d.redis), '7.2');
  assert.equal(d['${REGISTRY}/app:dev'].skip, 'variable');
  for (const f of ['Dockerfile', 'Dockerfile.dev', 'api.Dockerfile', 'Containerfile', 'docker-compose.yml', 'docker-compose.prod.yaml', 'compose.yml']) {
    assert.equal(parseManifest(f, '')?.ecosystem, 'docker', f);
  }
  assert.equal(parseManifest('dockerfile-notes.md', ''), null);
});
