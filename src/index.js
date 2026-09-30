// Programmatic API.
export { analyze, analyzeManifestText, applyUpdates, summarize } from './engine.js';
export { createResolver, latestCrate, latestGo, latestNpm, latestPypi } from './registries.js';
export { loadSnapshot, snapshotResolver, trackedSet } from './snapshot.js';
export { compareVersions, bumpVersionText, isMajorBump } from './semver.js';
export { createMcp, createHttpHandler } from './mcp.js';
