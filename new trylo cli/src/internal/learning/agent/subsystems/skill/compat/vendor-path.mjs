// Adapt the existing peripheral resolver to this unbundled, local Hermes tree.
// Never search Desktop, the Service Host entrypoint or the caller's cwd.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const vendorRoot = fileURLToPath(new URL('../vendor/legacy/', import.meta.url));

export function resolveLegacyVendorPath(name) {
  const candidate = path.resolve(vendorRoot, name);
  const relative = path.relative(vendorRoot, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return fs.existsSync(candidate) ? candidate : null;
}

export function requireLegacyVendor(name) {
  const resolved = resolveLegacyVendorPath(name);
  if (!resolved) throw new Error(`vendored legacy module not found: ${name}`);
  return require(resolved);
}

export function legacyVendorUrl(name) {
  const resolved = resolveLegacyVendorPath(name);
  if (!resolved) throw new Error(`vendored legacy module not found: ${name}`);
  return pathToFileURL(resolved).href;
}
