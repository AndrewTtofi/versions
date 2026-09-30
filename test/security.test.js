import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { analyze, analyzeManifestText, applyUpdates } from '../src/engine.js';
import { createHttpHandler, createMcp } from '../src/mcp.js';
import { lookupLatest } from '../src/registries.js';
import { isSafeVersion, isValidPackageName } from '../src/validate.js';
import { makeProject } from './helpers.js';

test('package names are validated per ecosystem', () => {
  for (const [eco, name] of [
    ['npm', 'zod'], ['npm', '@anthropic-ai/sdk'], ['npm', 'JSONStream'],
    ['pypi', 'Flask_SQLAlchemy'], ['cargo', 'serde_json'], ['go', 'github.com/spf13/cobra'], ['go', 'golang.org/x/sync'],
  ]) assert.ok(isValidPackageName(eco, name), `${eco}:${name}`);
  for (const [eco, name] of [
    ['npm', '../../etc/passwd'], ['npm', '@scope/../x'], ['npm', 'a b'], ['npm', 'x?y=1'], ['npm', ''],
    ['pypi', 'a/b'], ['cargo', '../x'], ['go', 'github.com/../../x'], ['go', 'localhost/x'], ['go', 'github.com/x y'],
    ['ruby', 'rails'],
  ]) assert.ok(!isValidPackageName(eco, name), `${eco}:${name}`);
});

test('only plain version strings are accepted', () => {
  for (const v of ['1.2.3', 'v1.2.3', '2.0.0-rc.1', '1.0.post1', '0.0.1790778300-g865493', 'v2.0.0+incompatible']) assert.ok(isSafeVersion(v), v);
  for (const v of ['1.0.0", "evil": "1', '1.0.0\nfoo', '$(rm -rf /)', 'latest', '', '1.0.0 ', '1.0.0,<2', null]) assert.ok(!isSafeVersion(v), String(v));
});

test('lookupLatest rejects malformed names before any network call', async () => {
  await assert.rejects(lookupLatest('npm', '../../x'), /Invalid npm package name/);
  await assert.rejects(lookupLatest('rubygems', 'rails'), /Unknown ecosystem/);
});

test('a malicious resolver cannot inject content into manifests', async () => {
  const pkg = '{\n  "dependencies": {\n    "zod": "^3.0.0"\n  }\n}\n';
  const dir = await makeProject({ 'package.json': pkg });
  const evil = async () => '9.9.9", "postinstall-backdoor": "1.0.0';
  const analysis = await analyze(dir, { resolve: evil });
  assert.equal(analysis.files[0].deps[0].status, 'error');
  assert.equal(await applyUpdates(analysis), 0);
  assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), pkg);

  const { updatedText } = await analyzeManifestText('package.json', pkg, { resolve: evil });
  assert.equal(updatedText, pkg);
});

test('local MCP tools cannot leave the project directory', async () => {
  const dir = await makeProject({ 'package.json': '{}' });
  const handle = createMcp({ cwd: dir });
  for (const path of ['..', '/etc', '../other-project']) {
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_project', arguments: { path } } });
    assert.equal(res.result.isError, true, path);
    assert.match(res.result.content[0].text, /inside the project directory/);
  }
  const ok = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check_project', arguments: { path: '.' } } });
  assert.notEqual(ok.result.isError, true);
});

test('MCP arguments are type- and size-checked', async () => {
  const handle = createMcp();
  const call = (name, args) => handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal((await call('latest_versions', { packages: 'zod' })).result.isError, true);
  assert.equal((await call('latest_versions', { packages: Array(101).fill('zod') })).result.isError, true);
  assert.equal((await call('check_manifest', { filename: 'package.json', content: 'x'.repeat(600 * 1024) })).result.isError, true);
  assert.equal((await call('check_manifest', { filename: 'package.json', content: '{}', exclude: 'x' })).result.isError, true);
  assert.equal((await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ping', arguments: [] } })).error.code, -32602);
  assert.equal((await call('__proto__', {})).error.code, -32602);
});

async function withServer(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const server = createServer(createHttpHandler()).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}/mcp`);
  } finally {
    server.close();
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

const ping = (url, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });

test('HTTP: browsers from unknown origins are refused (DNS rebinding, CSRF)', async () => {
  await withServer({ AGENT_VERSIONS_ALLOWED_ORIGINS: 'https://good.example' }, async (url) => {
    assert.equal((await ping(url, { origin: 'https://evil.example' })).status, 403);
    const good = await ping(url, { origin: 'https://good.example' });
    assert.equal(good.status, 200);
    assert.equal(good.headers.get('access-control-allow-origin'), 'https://good.example');
    assert.equal((await ping(url)).status, 200, 'server-to-server clients send no Origin');
  });
});

test('HTTP: rate limit, content type and batch limits', async () => {
  await withServer({ AGENT_VERSIONS_RATE_LIMIT: '3' }, async (url) => {
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await ping(url)).status);
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  });
  await withServer({}, async (url) => {
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    const big = JSON.stringify(Array(21).fill({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big })).status, 400);
    const bad = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1]' });
    assert.equal((await bad.json())[0].error.code, -32600);
  });
});

test('remote mode never exposes filesystem tools', async () => {
  const handle = createMcp({ remote: true });
  const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_project', arguments: {} } });
  assert.equal(res.error.code, -32602);
});
