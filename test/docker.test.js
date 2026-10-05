import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagShape } from '../src/manifests/docker.js';
import { bestTag, lookupLatest } from '../src/registries.js';

test('tag shapes keep the variant and the precision', () => {
  assert.equal(tagShape('20-alpine'), 'x-alpine');
  assert.equal(tagShape('3.12-slim-bookworm'), 'x.x-slim-bookworm');
  assert.equal(tagShape('v1.2.3'), 'vx.x.x');
  assert.equal(tagShape('x-alpine'), 'x-alpine');
  for (const t of ['latest', 'bookworm', '3.14.0a1', '20240101', 'lts-alpine']) assert.equal(tagShape(t), null, t);
});

test('bestTag picks the newest tag of the same shape only', () => {
  const tags = ['20-alpine', '22-alpine', '24-alpine', '24.9.0-alpine', '25-rc-alpine', '24-bookworm', '24', '9-alpine', '20240101-alpine'];
  assert.equal(bestTag(tags, 'x-alpine'), '24-alpine');
  assert.equal(bestTag(tags, 'x'), '24');
  assert.equal(bestTag(tags, 'x.x-slim'), null);
});

function fakeRegistry(t, routes) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.authorization });
    const handler = routes.find(([prefix]) => String(url).startsWith(prefix));
    if (!handler) return new Response('not found', { status: 404 });
    return handler[1](String(url), init);
  });
  return calls;
}

test('Docker Hub: anonymous token, then every page of tags', async (t) => {
  const calls = fakeRegistry(t, [
    ['https://auth.docker.io/token', () => Response.json({ token: 'tkn' })],
    ['https://registry-1.docker.io/v2/library/nodetest/tags/list', (url, init) => {
      if (!init?.headers?.authorization) {
        return new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nodetest:pull"' } });
      }
      if (!url.includes('last=')) {
        return Response.json({ tags: ['18-alpine', '20-alpine'] }, { headers: { link: '</v2/library/nodetest/tags/list?last=20-alpine&n=1000>; rel="next"' } });
      }
      return Response.json({ tags: ['22-alpine', '24-alpine', '24.1.0'] });
    }],
  ]);
  assert.equal(await lookupLatest('docker', 'nodetest:20-alpine'), '24-alpine');
  assert.ok(calls.some((c) => c.url.startsWith('https://auth.docker.io/token?') && c.url.includes('scope=repository%3Alibrary%2Fnodetest%3Apull')));
  assert.ok(calls.filter((c) => c.url.includes('/tags/list')).every((c, i) => i === 0 || c.auth === 'Bearer tkn'));
});

test('registries cannot redirect tokens or pages to other hosts', async (t) => {
  fakeRegistry(t, [
    ['https://ghcr.io/v2/evil/realm/tags/list', () =>
      new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://169.254.169.254/token",service="x"' } })],
    ['https://quay.io/v2/evil/link/tags/list', () =>
      Response.json({ tags: ['1.0.0'] }, { headers: { link: '<https://169.254.169.254/v2/x?n=1>; rel="next"' } })],
  ]);
  await assert.rejects(lookupLatest('docker', 'ghcr.io/evil/realm:1.0.0'), /Unexpected token endpoint/);
  assert.equal(await lookupLatest('docker', 'quay.io/evil/link:0.9.0'), '1.0.0');
});

test('unknown registries and bad image names never reach the network', async (t) => {
  const calls = fakeRegistry(t, []);
  await assert.rejects(lookupLatest('docker', 'registry.internal.corp/app:1.0'), /Invalid docker package name/);
  await assert.rejects(lookupLatest('docker', '169.254.169.254/x:1.0'), /Invalid docker package name/);
  await assert.rejects(lookupLatest('docker', 'node:../../x'), /Invalid docker package name/);
  await assert.rejects(lookupLatest('docker', 'Node:20'), /Invalid docker package name/);
  assert.equal(calls.length, 0);
});
