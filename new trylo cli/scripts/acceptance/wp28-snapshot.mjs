// Freeze the working source without touching the shared Git index or build tree.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const target = resolve(process.argv[2] ?? "");
if (process.argv[2] === undefined || existsSync(target)) {
  throw new Error("snapshot requires a new, explicit destination directory");
}

mkdirSync(target, { recursive: true });

const entries = ["src", "scripts", "testdata", "docs", "vendor-bin", ".agents", "AGENTS.md", "README.md", "package.json", "package-lock.json", "tsconfig.json", ".gitignore", ".gitattributes"];

for (const entry of entries) {
  cpSync(join(root, entry), join(target, entry), {
    recursive: true,
    filter(file) {
      if (file.includes(join("vendor-bin", "pty", "target"))) return false;
      // Adjacent JS emitted by old probes is not a build input. Vendored JS is.
      return !file.endsWith(".js") || file.includes(`${join("vendor", "sandbox-runtime")}`) || !existsSync(file.slice(0, -3) + ".ts");
    },
  });
}

const manifest = [];

function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) scan(file);
    else if (entry.isFile()) manifest.push({ path: relative(target, file).replaceAll("\\", "/"), sha256: createHash("sha256").update(readFileSync(file)).digest("hex") });
    else throw new Error(`snapshot contains an unsupported link: ${file}`);
  }
}

scan(target);

const sourceHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
const buildFiles = manifest.filter(file => /^(src|scripts|testdata|vendor-bin)\//.test(file.path) || ["package.json", "package-lock.json", "tsconfig.json"].includes(file.path));
const buildInputHash = createHash("sha256").update(JSON.stringify(buildFiles)).digest("hex");

writeFileSync(join(target, "source-manifest.json"), JSON.stringify({ sourceHash, buildInputHash, files: manifest }, null, 2) + "\n");

console.log(JSON.stringify({ target, sourceHash, buildInputHash, fileCount: manifest.length }));
