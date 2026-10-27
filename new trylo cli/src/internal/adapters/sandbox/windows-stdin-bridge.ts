import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { cacheWindowsBytes } from "./windows-helper-cache.js";
import { protectWindowsCacheTarget } from "./windows-helper-protection.js";

const MODULES = ["windows-stdin-host.js", "windows-stdin-client.js", "windows-stdin-protocol.js", "../process-session/process-tree.js"];
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Capture before granting workspace writes. Lazy publication never re-reads mutable package files. */
export function captureWindowsStdinBridge() {
  const files = MODULES.map(name => ({ name, bytes: readFileSync(new URL(name, import.meta.url)) }));
  const metadata = Buffer.from('{"type":"module"}\n');
  const identity = digest(Buffer.concat([metadata, ...files.map(file => file.bytes)]));
  return (env: Readonly<Record<string, string | undefined>>, writableRoots: readonly string[]) => {
    const local = env["LOCALAPPDATA"];
    if (local === undefined || local.length === 0) throw new Error("isolation_helper_invalid: host LOCALAPPDATA is missing");
    const root = join(local, "trylo-cli-native", `stdin-${identity}`);
    const protect = (target: Parameters<typeof protectWindowsCacheTarget>[0]) => protectWindowsCacheTarget(target, env);
    // Establish the protected root before nested directories can inherit access.
    const packageMetadata = cacheWindowsBytes(metadata, digest(metadata), root, "package.json", protect, writableRoots);
    for (const file of files) {
      const target = join(root, "sandbox", file.name);
      cacheWindowsBytes(file.bytes, digest(file.bytes), dirname(target), basename(target), protect, writableRoots);
    }
    return { host: join(root, "sandbox/windows-stdin-host.js"), client: join(root, "sandbox/windows-stdin-client.js"), packageMetadata };
  };
}
