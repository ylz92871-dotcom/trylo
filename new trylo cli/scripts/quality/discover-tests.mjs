import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export function getTestLayer(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.endsWith(".platform.test.ts") || normalized.endsWith(".platform.test.js")) {
    return "platform";
  }

  if (normalized.endsWith(".real.test.ts") || normalized.endsWith(".real.test.js")) {
    return "real";
  }

  return "hermetic";
}

export function listTestSources(srcRoot, layer = "hermetic") {
  const files = [];
  const pending = [srcRoot];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }

    let entries;

    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = join(current, entry.name);

      if (entry.isDirectory()) {
        pending.push(full);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        const testLayer = getTestLayer(entry.name);
        if (layer === "all" || layer === testLayer) {
          files.push(full);
        }
      }
    }
  }

  files.sort((a, b) => a.localeCompare(b));

  return files;
}

export function mapSourceToDist(srcFile, srcRoot, distRoot) {
  const rel = relative(srcRoot, srcFile).replace(/\\/g, "/");
  if (!rel.endsWith(".test.ts")) {
    return undefined;
  }
  return join(distRoot, `${rel.slice(0, -3)}.js`);
}

export function discoverRunnableTests(srcRoot, distRoot, layer = "hermetic") {
  const runnable = [];

  for (const srcFile of listTestSources(srcRoot, layer)) {
    const distFile = mapSourceToDist(srcFile, srcRoot, distRoot);
    if (distFile !== undefined) {
      runnable.push({ srcFile, distFile });
    }
  }

  return runnable;
}

export function listDistTestFiles(distRoot) {
  const files = [];
  const pending = [distRoot];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }

    let entries;

    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = join(current, entry.name);

      if (entry.isDirectory()) {
        pending.push(full);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".test.js")) {
        files.push(full);
      }
    }
  }

  return files;
}

export function isStaleDistTest(distFile, srcRoot, distRoot) {
  const rel = relative(distRoot, distFile).replace(/\\/g, "/");
  if (!rel.endsWith(".test.js")) {
    return false;
  }
  const srcFile = join(srcRoot, `${rel.slice(0, -3)}.ts`);
  return !existsSync(srcFile);
}
