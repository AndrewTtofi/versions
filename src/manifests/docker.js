// Container images: Dockerfile / Containerfile `FROM` and `COPY --from=` lines,
// and `image:` entries in Compose files. Only the tag is ever rewritten, and
// only to a tag of the same shape: `node:20-alpine` moves to `24-alpine`.

import { DOCKER_REGISTRIES, isSafeVersion, isValidPackageName } from '../validate.js';

export const ecosystem = 'docker';

const DOCKERFILE_RE = /^(?:(?:Docker|Container)file(?:\..+)?|.+\.(?:docker|container)file)$/i;
const COMPOSE_RE = /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/i;

export function matches(filename) {
  return DOCKERFILE_RE.test(filename) || COMPOSE_RE.test(filename);
}

const DOCKER_HUB_ALIASES = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);

/** Split "ghcr.io/org/app:1.2-slim@sha256:..." into its parts. */
export function parseImageRef(ref) {
  let rest = ref;
  let digest = null;
  const at = rest.indexOf('@');
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag = null;
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const parts = rest.split('/');
  let host = 'docker.io';
  if (parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === 'localhost')) host = parts.shift().toLowerCase();
  if (DOCKER_HUB_ALIASES.has(host)) host = 'docker.io';
  if (host === 'docker.io' && parts.length === 1) parts.unshift('library');
  return { image: rest, host, repository: parts.join('/'), tag, digest, tagOffset: tag == null ? -1 : colon + 1 };
}

/**
 * The shape of a version tag, with each number replaced by "x":
 * "20-alpine" -> "x-alpine", "v1.2.3" -> "vx.x.x". Null for tags that aren't
 * versions ("latest", "bookworm"), prereleases ("3.14.0a1") and date stamps.
 */
export function tagShape(tag) {
  const shape = tag.match(/^(v?)(x(?:\.x)*)(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/);
  if (shape) return tag;
  const m = tag.match(/^(v?)(\d{1,4}(?:\.\d+)*)(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/);
  if (!m || !isSafeVersion(tag)) return null;
  return m[1] + m[2].split('.').map(() => 'x').join('.') + (m[3] ?? '');
}

/** One image reference found at `offset` in the file, or null if it isn't a dependency. */
function imageDep(ref, offset, section) {
  if (/^scratch$/i.test(ref)) return null;
  const dep = { name: ref, spec: ref, section };
  if (ref.includes('$')) {
    dep.skip = 'variable';
    return dep;
  }
  const { image, host, repository, tag, digest, tagOffset } = parseImageRef(ref);
  dep.name = image;
  if (digest) dep.skip = 'pinned to a digest';
  else if (!DOCKER_REGISTRIES.has(host)) dep.skip = 'private registry';
  else if (!tag || tag === 'latest') dep.skip = 'unpinned';
  else if (!tagShape(tag)) dep.skip = 'not a version tag';
  if (dep.skip) return dep;
  const lookupName = `${host}/${repository}:${tagShape(tag)}`;
  if (!isValidPackageName('docker', lookupName)) {
    dep.skip = 'invalid image name';
    return dep;
  }
  return { ...dep, lookupName, prefix: '', version: tag, start: offset + tagOffset, end: offset + tagOffset + tag.length };
}

function parseDockerfile(text) {
  const deps = [];
  const stages = new Set();
  let offset = 0;
  for (const line of text.split('\n')) {
    const from = line.match(/^(\s*FROM\s+(?:--\S+\s+)*)(\S+)(?:\s+AS\s+(\S+))?/i);
    if (from) {
      const [, lead, ref, alias] = from;
      if (!stages.has(ref.toLowerCase())) {
        const dep = imageDep(ref, offset + lead.length, 'FROM');
        if (dep) deps.push(dep);
      }
      if (alias) stages.add(alias.toLowerCase());
    }
    const copy = line.match(/^(\s*(?:COPY|ADD)\s+(?:--\S+\s+)*?--from=)([^\s]+)/i);
    if (copy) {
      const [, lead, ref] = copy;
      // --from names a build stage or a stage index unless it looks like an image.
      if (!stages.has(ref.toLowerCase()) && !/^\d+$/.test(ref) && /[:/]/.test(ref)) {
        const dep = imageDep(ref, offset + lead.length, 'COPY --from');
        if (dep) deps.push(dep);
      }
    }
    offset += line.length + 1;
  }
  return deps;
}

function parseCompose(text) {
  const deps = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const m = line.match(/^(\s*image:\s*(["']?))([^\s"'#]+)\2\s*(?:#.*)?\r?$/);
    if (m) {
      const dep = imageDep(m[3], offset + m[1].length, 'image');
      if (dep) deps.push(dep);
    }
    offset += line.length + 1;
  }
  return deps;
}

export function parse(text, filename = 'Dockerfile') {
  return COMPOSE_RE.test(filename) ? parseCompose(text) : parseDockerfile(text);
}
