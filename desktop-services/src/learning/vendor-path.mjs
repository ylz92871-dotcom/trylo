// Trylo Desktop Services — vendored legacy module resolution.
//
// A module-relative `require('../../vendor/legacy/x.js')` breaks the moment
// esbuild inlines this module into `dist/host.bundle.mjs`: `import.meta.url`
// then points at the bundle, and `../..` escapes the package root — the same
// MODULE_NOT_FOUND that silently killed the pet in `pet/pet-channel.mjs`.
// Every Hermes adapter goes through this one resolver so the bug cannot come
// back per-module.
//
// Ownership: resolution only. It never rewrites or wraps what it loads.
//
// Failure policy: `resolveLegacyVendorPath` returns null when the module is
// absent (callers degrade); `requireLegacyVendor` throws, because a caller
// that requires eagerly cannot continue without the module.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * @param {string} name - path relative to vendor/legacy (e.g.
 *   'hermes-python-resolver.js' or 'learning-loop/orchestrator.js').
 * @returns {string|null} absolute path, or null when not found.
 */
export function resolveLegacyVendorPath(name) {
  const rel = path.join('vendor', 'legacy', name);
  const candidates = [];
  if (process.argv[1]) {
    // Both entry layouts sit ONE level below the package root:
    //   - node src/host.mjs        → src/..   = package root
    //   - node dist/host.bundle.mjs → dist/..  = package root
    //   - <resource>/desktop-services/dist/host.bundle.mjs → same
    candidates.push(path.resolve(path.dirname(path.resolve(process.argv[1])), '..', rel));
  }
  // Unbundled fallback: this file really lives at src/learning/.
  candidates.push(fileURLToPath(new URL(`../../${rel}`, import.meta.url)));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Require a vendored legacy module by name. Throws when it is missing so the
 * Service Host turns it into an error frame instead of a silent degrade.
 */
export function requireLegacyVendor(name) {
  const resolved = resolveLegacyVendorPath(name);
  if (!resolved) {
    throw new Error(`vendored legacy module not found: ${name}`);
  }
  return require(resolved);
}

/** file:// URL for a dynamic `import()` of a vendored legacy ESM/CJS module. */
export function legacyVendorUrl(name) {
  const resolved = resolveLegacyVendorPath(name);
  if (!resolved) {
    throw new Error(`vendored legacy module not found: ${name}`);
  }
  return new URL(`file:///${resolved.replace(/\\/g, '/')}`).href;
}
