// Small, dependency-free version helpers that work well enough across
// npm (semver), PyPI (PEP 440), crates.io (semver) and Go modules.

const VERSION_RE = /^v?(\d+(?:\.\d+)*)(.*)$/i;

export function parseVersion(input) {
  if (input == null) return null;
  const m = String(input).trim().match(VERSION_RE);
  if (!m) return null;
  const parts = m[1].split('.').map(Number);
  let rest = m[2];
  // Build metadata ("+incompatible", "+build.5") never affects precedence.
  rest = rest.replace(/\+.*$/, '');
  // PEP 440 post releases sort after the release; treat them as releases.
  if (/^[.-]?post\d*$/i.test(rest)) rest = '';
  const pre = rest.replace(/^[-.]/, '');
  return { parts, pre };
}

export function isPrerelease(input) {
  const v = parseVersion(input);
  return !v || v.pre !== '';
}

function comparePre(a, b) {
  if (a === b) return 0;
  if (a === '') return 1;
  if (b === '') return -1;
  const as = a.split(/[.-]|(?<=\D)(?=\d)|(?<=\d)(?=\D)/);
  const bs = b.split(/[.-]|(?<=\D)(?=\d)|(?<=\d)(?=\D)/);
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    if (as[i] === undefined) return -1;
    if (bs[i] === undefined) return 1;
    const an = /^\d+$/.test(as[i]);
    const bn = /^\d+$/.test(bs[i]);
    if (an && bn) {
      const d = Number(as[i]) - Number(bs[i]);
      if (d) return Math.sign(d);
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (as[i] !== bs[i]) {
      return as[i] < bs[i] ? -1 : 1;
    }
  }
  return 0;
}

/** Returns -1, 0 or 1. Unparseable versions sort first. */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return va ? 1 : vb ? -1 : 0;
  const len = Math.max(va.parts.length, vb.parts.length);
  for (let i = 0; i < len; i++) {
    const d = (va.parts[i] ?? 0) - (vb.parts[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return comparePre(va.pre, vb.pre);
}

export function maxVersion(versions, { includePrerelease = false } = {}) {
  let best = null;
  for (const v of versions) {
    if (!parseVersion(v)) continue;
    if (!includePrerelease && isPrerelease(v)) continue;
    if (best === null || compareVersions(v, best) > 0) best = v;
  }
  return best;
}

/**
 * Semver-style "breaking" change: the first non-zero component differs.
 * 1.x -> 2.x is major, and so is 0.3 -> 0.4 (caret semantics).
 */
export function isMajorBump(from, to) {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
    const x = a.parts[i] ?? 0;
    const y = b.parts[i] ?? 0;
    if (x !== y) return true;
    if (x !== 0) return false;
  }
  return false;
}

/**
 * Work out the version text that should replace `current` so it points at
 * `latest`, keeping the precision the author chose ("1.2" stays two parts).
 * Returns null when nothing should change.
 */
export function bumpVersionText(current, latest) {
  const cur = parseVersion(current);
  const lat = parseVersion(latest);
  if (!cur || !lat) return null;
  let next = latest.replace(/^v/i, '');
  if (cur.pre === '' && cur.parts.length < lat.parts.length) {
    next = lat.parts.slice(0, cur.parts.length).join('.');
  }
  if (/^v/i.test(current) && !/^v/i.test(next)) next = 'v' + next;
  if (compareVersions(next, current) <= 0) return null;
  return next;
}

/**
 * Size of an update: 'major' (breaking under caret rules), 'minor' (the
 * component after the first non-zero one changed) or 'patch' (anything smaller).
 */
export function bumpLevel(from, to) {
  if (isMajorBump(from, to)) return 'major';
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return 'major';
  const firstNonZero = a.parts.findIndex((p) => p !== 0);
  const changed = Array.from({ length: Math.max(a.parts.length, b.parts.length) }, (_, i) => i).find(
    (i) => (a.parts[i] ?? 0) !== (b.parts[i] ?? 0),
  );
  if (changed === undefined) return 'patch';
  return changed <= Math.max(firstNonZero, 0) + 1 ? 'minor' : 'patch';
}

export const LEVEL_RANK = { none: 0, patch: 1, minor: 2, major: 3 };
