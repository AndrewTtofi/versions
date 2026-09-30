import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bumpVersionText, compareVersions, isMajorBump, maxVersion } from '../src/semver.js';

test('compareVersions orders releases and prereleases', () => {
  assert.equal(compareVersions('1.2.3', '1.2.10'), -1);
  assert.equal(compareVersions('2.0.0', '2.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('v1.2.0', '1.1.9'), 1);
  assert.equal(compareVersions('2.0.0a1', '2.0.0'), -1);
  assert.equal(compareVersions('1.0.post1', '1.0'), 0);
  assert.equal(compareVersions('v2.0.0+incompatible', 'v2.0.0'), 0);
});

test('maxVersion skips prereleases unless asked', () => {
  assert.equal(maxVersion(['1.0.0', '1.2.0', '2.0.0-beta.1']), '1.2.0');
  assert.equal(maxVersion(['2.0.0-beta.1'], { includePrerelease: true }), '2.0.0-beta.1');
});

test('isMajorBump uses caret semantics', () => {
  assert.equal(isMajorBump('1.2.3', '2.0.0'), true);
  assert.equal(isMajorBump('1.2.3', '1.9.0'), false);
  assert.equal(isMajorBump('0.3.1', '0.4.0'), true);
  assert.equal(isMajorBump('0.3.1', '0.3.9'), false);
  assert.equal(isMajorBump('0.0.1', '0.0.2'), true);
});

test('bumpVersionText keeps the author precision', () => {
  assert.equal(bumpVersionText('1.2.3', '1.4.0'), '1.4.0');
  assert.equal(bumpVersionText('1', '1.5.0'), null);
  assert.equal(bumpVersionText('1', '2.1.0'), '2');
  assert.equal(bumpVersionText('1.2', '1.5.3'), '1.5');
  assert.equal(bumpVersionText('v1.2.3', 'v1.3.0'), 'v1.3.0');
  assert.equal(bumpVersionText('2.0.0', '1.9.0'), null, 'never downgrades');
  assert.equal(bumpVersionText('1.0.0-beta.1', '1.0.0'), '1.0.0');
});
