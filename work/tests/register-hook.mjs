// Trylo Work — register hook entry point for the
// .js → .ts Node ESM loader. Used as
//   node --import ./tests/register-hook.mjs --test tests/
//
// See loader.mjs for the actual resolve() hook.

import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";

const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);
const loaderUrl = pathToFileURL(pathResolve(hereDir, "loader.mjs")).href;
register(loaderUrl, pathToFileURL(herePath));
