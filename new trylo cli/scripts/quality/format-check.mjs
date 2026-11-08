import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const skipDirs = new Set([".git", "node_modules", "dist", "open"]);

function walk(dir, acc = []) {
  let entries;

  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }

  for (const entry of entries) {
    if (skipDirs.has(entry.name)) {
      continue;
    }

    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(full, acc);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      acc.push(full);
    }
  }

  return acc;
}

const problems = [];

for (const file of walk(join(root, "src"))) {
  const text = readFileSync(file, "utf8");
  const rel = relative(root, file).replaceAll("\\", "/");

  if (text.length > 0 && !text.endsWith("\n")) {
    problems.push(`${rel}: missing final newline`);
  }

  if (text.includes("\r\n")) {
    problems.push(`${rel}: CRLF line endings are not allowed (use LF)`);
  }

  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line !== undefined && /[ \t]+$/.test(line)) {
      problems.push(`${rel}:${i + 1}: trailing whitespace`);
    }
  }
}

if (problems.length > 0) {
  console.error("FAIL format-check");
  for (const problem of problems) {
    console.error(problem);
  }
  process.exit(1);
}

console.log("PASS format-check");
