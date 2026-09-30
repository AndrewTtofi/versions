// Input/output validation. Package names come from untrusted manifests and
// MCP callers; versions come from registries and the downloaded snapshot.
// Anything that reaches a URL or gets written into a user's manifest must
// pass these checks first.

const NAME_RULES = {
  // npm: optional scope, URL-safe characters only (legacy names may be mixed-case).
  npm: { re: /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9_][a-z0-9._~-]*$/i, max: 214 },
  // PEP 508 names.
  pypi: { re: /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/, max: 200 },
  // crates.io names.
  cargo: { re: /^[A-Za-z][A-Za-z0-9_-]*$/, max: 64 },
  // Go module paths: host with a dot, then path elements.
  go: { re: /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[A-Za-z0-9._~+-]+)*$/, max: 300 },
};

export function isValidPackageName(ecosystem, name) {
  const rule = NAME_RULES[ecosystem];
  if (!rule || typeof name !== 'string' || name.length > rule.max || !rule.re.test(name)) return false;
  // No "." / ".." path elements - they would walk the registry URL.
  return !name.split('/').some((part) => part === '.' || part === '..');
}

// Digits-first, then only characters that can appear in real versions. No
// quotes, whitespace, commas, brackets or newlines can ever get through.
const VERSION_RE = /^v?\d{1,9}(?:\.\d{1,9}){0,5}(?:[-.+]?[0-9A-Za-z][0-9A-Za-z.+-]{0,80})?$/;

export function isSafeVersion(version) {
  return typeof version === 'string' && version.length <= 128 && VERSION_RE.test(version);
}
