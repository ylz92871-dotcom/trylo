import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Snapshot the existing trusted MCP client; do not introduce a second JSON-RPC or handshake implementation. */
export async function snapshotNpmMcpClient(destination: string): Promise<void> {
  const base = fileURLToPath(new URL("../../../", import.meta.url));
  const queue = ["internal/adapters/mcp-stdio/client.js"], seen = new Set<string>(); let total = 0;
  while (queue.length > 0) {
    const relative = queue.shift()!;
    if (seen.has(relative)) continue;
    if (seen.size >= 128 || !relative.endsWith(".js") || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("trusted MCP runtime closure exceeded its boundary");
    const source = await readFile(path.join(base, relative), "utf8"); total += Buffer.byteLength(source); seen.add(relative);
    if (total > 2 * 1024 * 1024) throw new Error("trusted MCP runtime closure exceeded its byte bound");
    for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)) {
      const spec = match[1]!;
      if (spec.startsWith("node:")) continue;
      if (!spec.startsWith(".")) throw new Error("trusted MCP runtime unexpectedly requires a third-party module");
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(relative), spec)));
    }
    const absolute = path.join(destination, relative); await mkdir(path.dirname(absolute), { recursive: true }); await writeFile(absolute, source, { flag: "wx" });
  }
  await writeFile(path.join(destination, "package.json"), '{"type":"module"}\n', { flag: "wx" });
}
