import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analyze, analyzeManifestText, applyUpdates, summarize } from '../src/engine.js';
import { fakeResolve, makeProject } from './helpers.js';

const PKG = `{
  "name": "demo",
  "dependencies": {
    "zod": "^3.22.4",
    "react": "~19.0.0",
    "left-pad": "1.3.0"
  },
  "devDependencies": {
    "typescript": "^5.4.5"
  },
  "peerDependencies": {
    "react": "^18.0.0"
  }
}
`;

test('update rewrites versions and keeps formatting', async () => {
  const dir = await makeProject({
    'package.json': PKG,
    'api/requirements.txt': 'requests==2.31.0\nfastapi>=0.100.0\n',
    'node_modules/x/package.json': '{"dependencies":{"zod":"1.0.0"}}',
  });
  const analysis = await analyze(dir, { resolve: fakeResolve });
  assert.equal(analysis.files.length, 2, 'node_modules is ignored');
  assert.deepEqual(summarize(analysis), { outdated: 5, held: 0, current: 1, skipped: 1, error: 0 });
  assert.equal(await applyUpdates(analysis), 5);

  const pkg = await readFile(join(dir, 'package.json'), 'utf8');
  assert.equal(pkg, PKG.replace('^3.22.4', '^4.1.0').replace('~19.0.0', '~19.2.0').replace('^5.4.5', '^5.9.0'));
  const req = await readFile(join(dir, 'api/requirements.txt'), 'utf8');
  assert.equal(req, 'requests==2.32.5\nfastapi>=0.120.0\n');
});

test('--no-major holds back breaking updates', async () => {
  const dir = await makeProject({ 'package.json': PKG });
  const analysis = await analyze(dir, { resolve: fakeResolve, noMajor: true });
  const zod = analysis.files[0].deps.find((d) => d.name === 'zod');
  assert.equal(zod.status, 'held');
  assert.equal(zod.major, true);
  await applyUpdates(analysis);
  assert.match(await readFile(join(dir, 'package.json'), 'utf8'), /"zod": "\^3\.22\.4"/);
});

test('exclude, tracked and peer options', async () => {
  const dir = await makeProject({ 'package.json': PKG });
  const analysis = await analyze(dir, {
    resolve: fakeResolve,
    exclude: ['type*'],
    tracked: new Set(['npm:zod', 'npm:typescript', 'npm:react']),
    includePeer: true,
  });
  const status = Object.fromEntries(analysis.files[0].deps.map((d) => [`${d.name}/${d.section}`, d.status]));
  assert.deepEqual(status, {
    'zod/dependencies': 'outdated',
    'react/dependencies': 'outdated',
    'left-pad/dependencies': 'skipped',
    'typescript/devDependencies': 'skipped',
    'react/peerDependencies': 'outdated',
  });
});

test('registry failures are reported, not thrown', async () => {
  const dir = await makeProject({ 'package.json': '{"dependencies":{"zod":"1.0.0","nope":"1.0.0"}}' });
  const resolve = async (eco, name) => {
    if (name === 'nope') throw new Error('boom');
    return fakeResolve(eco, name);
  };
  const analysis = await analyze(dir, { resolve });
  const nope = analysis.files[0].deps.find((d) => d.name === 'nope');
  assert.equal(nope.status, 'error');
  assert.equal(nope.reason, 'boom');
});

test('analyzeManifestText returns updated content for all ecosystems', async () => {
  const cargo = '[dependencies]\nserde = { version = "1.0.190", features = ["derive"] }\ntokio = "1"\nrand = "0.8"\n';
  const { updatedText } = await analyzeManifestText('Cargo.toml', cargo, { resolve: fakeResolve });
  assert.equal(updatedText, '[dependencies]\nserde = { version = "1.0.228", features = ["derive"] }\ntokio = "1"\nrand = "0.9"\n');

  const gomod = 'module x\n\nrequire (\n\tgithub.com/spf13/cobra v1.8.0\n\tgolang.org/x/sync v0.5.0 // indirect\n)\n';
  const go = await analyzeManifestText('go.mod', gomod, { resolve: fakeResolve });
  assert.equal(go.updatedText, gomod.replace('v1.8.0', 'v1.10.1'));

  const py = '[project]\ndependencies = ["pydantic>=2.5.0", "httpx==0.27.0"]\n';
  const pyres = await analyzeManifestText('pyproject.toml', py, { resolve: fakeResolve });
  assert.equal(pyres.updatedText, '[project]\ndependencies = ["pydantic>=2.12.0", "httpx==0.28.1"]\n');

  await assert.rejects(analyzeManifestText('Gemfile', '', { resolve: fakeResolve }), /Unsupported manifest/);
});

test('collect records lookup failures instead of aborting the run', async () => {
  const { collect } = await import('../src/collect.js');
  const sources = { tools: [{ id: 't', name: 'T', packages: { npm: ['zod', 'flaky'] } }] };
  // packageDeps/repos are not used, so no network is touched.
  const resolve = async (eco, name) => {
    if (name === 'flaky') throw new Error('429 Too Many Requests');
    return '4.1.0';
  };
  const snap = await collect(sources, { resolve, previous: null });
  assert.equal(snap.tools.t.packages.npm.zod, '4.1.0');
  assert.ok(snap.errors.some((e) => e.package === 'npm:flaky'));
});

test('collect skips dependencies a tool lists in ignore', async (t) => {
  const { collect } = await import('../src/collect.js');
  const manifest = { dependencies: { zod: '^4.0.0', '@acme/unpublished': '1.0.0' } };
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(manifest)));
  const sources = {
    tools: [{ id: 't', name: 'T', packageDeps: { npm: ['acme-cli'] }, ignore: ['npm:@acme/unpublished'] }],
  };
  const resolve = async (eco, name) => (name === 'zod' ? '4.1.0' : null);
  const snap = await collect(sources, { resolve, previous: null });
  assert.deepEqual(Object.keys(snap.packages.npm), ['zod']);
  assert.deepEqual(snap.errors, []);
});
