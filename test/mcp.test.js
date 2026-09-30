import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHttpHandler, createMcp } from '../src/mcp.js';

test('initialize negotiates protocol and lists tools', async () => {
  const handle = createMcp();
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(init.result.serverInfo.name, 'agent-versions');
  const unknown = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(unknown.result.protocolVersion, '2025-06-18');
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    ['latest_versions', 'ai_tool_versions', 'tool_stack', 'check_manifest', 'check_project', 'update_project'],
  );
  const missing = await handle({ jsonrpc: '2.0', id: 4, method: 'nope' });
  assert.equal(missing.error.code, -32601);
});

test('remote mode hides filesystem tools', async () => {
  const handle = createMcp({ remote: true });
  const list = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.ok(!list.result.tools.some((t) => t.name === 'update_project' || t.name === 'check_project'));
  const call = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'update_project', arguments: {} } });
  assert.equal(call.error.code, -32602);
});

test('tool errors come back as isError results', async () => {
  const handle = createMcp();
  const res = await handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'check_manifest', arguments: { filename: 'Gemfile', content: '' } },
  });
  assert.equal(res.result.isError, true);
});

test('stdio transport answers line-delimited JSON-RPC', async () => {
  const bin = fileURLToPath(new URL('../bin/agent-versions.js', import.meta.url));
  const child = spawn(process.execPath, [bin, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  child.stdout.setEncoding('utf8').on('data', (d) => lines.push(...d.split('\n').filter(Boolean)));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
  child.stdin.write('not json\n');
  await new Promise((r) => setTimeout(r, 500));
  child.kill();
  const replies = lines.map((l) => JSON.parse(l));
  assert.deepEqual(replies.find((r) => r.id === 1), { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(replies.find((r) => r.id === null).error.code, -32700);
});

test('HTTP transport', async () => {
  const server = createServer(createHttpHandler()).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (body) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const res = await post({ jsonrpc: '2.0', id: 7, method: 'ping' });
    assert.deepEqual(await res.json(), { jsonrpc: '2.0', id: 7, result: {} });
    assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    assert.equal((await fetch(`${base}/mcp`)).status, 405);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  } finally {
    server.close();
  }
});
