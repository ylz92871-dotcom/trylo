import { cpSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../src/internal/builtin-skills/", import.meta.url));
const destination = fileURLToPath(new URL("../dist/internal/builtin-skills/", import.meta.url));
mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true });
console.log("Copied official skill assets into the CLI runtime.");
