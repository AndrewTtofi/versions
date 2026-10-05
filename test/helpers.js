import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const LATEST = {
  'npm:zod': '4.1.0',
  'npm:react': '19.2.0',
  'npm:typescript': '5.9.0',
  'npm:left-pad': '1.3.0',
  'npm:qs': '6.20.0',
  'npm:vite': '7.1.0',
  'pypi:requests': '2.32.5',
  'pypi:fastapi': '0.120.0',
  'pypi:pydantic': '2.12.0',
  'pypi:httpx': '0.28.1',
  'pypi:rich': '14.1.0',
  'pypi:ruff': '0.14.0',
  'cargo:serde': '1.0.228',
  'cargo:tokio': '1.48.0',
  'cargo:clap': '4.5.50',
  'cargo:rand': '0.9.2',
  'cargo:toml': '0.9.8',
  'go:github.com/spf13/cobra': 'v1.10.1',
  'go:golang.org/x/sync': 'v0.17.0',
  'go:github.com/pkg/errors': 'v0.9.1',
  'docker:docker.io/library/node:x-alpine': '24-alpine',
  'docker:docker.io/library/python:x.x-slim': '3.14-slim',
};

export const fakeResolve = async (eco, name) => LATEST[`${eco}:${name}`] ?? null;

export async function makeProject(files) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-versions-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}
