// Trylo Work — minimal Node ESM loader for .ts test files.
//
// Why this exists: Node 24's native TypeScript support
// strips types but does NOT rewrite `.js` import specifiers
// to `.ts` files. The Trylo Work source uses `.js`
// extensions in its imports (standard ESM + TS-bundler
// resolution), so the test runner needs a loader to find
// the underlying `.ts` files.
//
// This is the smallest possible hook: when a `.js` import
// fails, retry as `.ts` (then `.tsx`). No dependency,
// no extra config — just
//   node --import ./tests/loader.mjs --test tests/
//
// We deliberately do NOT add this to work/package.json
// `scripts.test` because (a) the file lives in tests/ and
// (b) the user can opt in. It's here so the test can be
// reproduced by anyone who reads the test file's header.

import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";

const TS_EXTS = [".ts", ".tsx", ".mts", ".cts"];

export async function resolve(specifier, context, nextResolve) {
  // Only intercept relative `.js` / explicit-path imports
  // that the default resolver couldn't satisfy. Module
  // names like `node:test` and `node:assert` are left alone
  // by the default resolver anyway.
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.startsWith("node:")) throw err;
    if (!isRelative(specifier)) throw err;
    // Resolve relative to the parent file.
    const parentURL = context.parentURL;
    if (!parentURL || !parentURL.startsWith("file://")) throw err;
    const parentDir = dirname(fileURLToPath(parentURL));
    const target = pathResolve(parentDir, specifier);
    // Case 1: specifier ends in `.js` — try the TS variants.
    if (specifier.endsWith(".js")) {
      for (const ext of TS_EXTS) {
        const candidate = target.slice(0, -3) + ext;
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return nextResolve(pathToFileURL(candidate).href, context);
        }
        const indexCandidate = pathResolve(target.slice(0, -3), `index${ext}`);
        if (existsSync(indexCandidate) && statSync(indexCandidate).isFile()) {
          return nextResolve(pathToFileURL(indexCandidate).href, context);
        }
      }
      throw err;
    }
    // Case 2: extensionless relative import — try the TS
    // variants directly. This handles TypeScript's
    // `bundler` moduleResolution style where `import './foo'`
    // maps to `./foo.ts` at runtime.
    for (const ext of TS_EXTS) {
      const candidate = target + ext;
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return nextResolve(pathToFileURL(candidate).href, context);
      }
      const indexCandidate = pathResolve(target, `index${ext}`);
      if (existsSync(indexCandidate) && statSync(indexCandidate).isFile()) {
        return nextResolve(pathToFileURL(indexCandidate).href, context);
      }
    }
    throw err;
  }
}

function isRelative(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}
