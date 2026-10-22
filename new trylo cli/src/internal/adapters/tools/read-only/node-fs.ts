import { open, readFile, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { DirectoryEntry, FileSystemReader } from "./limits.js";

/**
 * Node filesystem reader for the built-in read-only tools.
 *
 * Directories are never followed through a symbolic link: `withFileTypes`
 * reports a link as a link, not as a directory, so a link pointing outside the
 * workspace is skipped by the search walk instead of being traversed.
 */

export function createNodeFileSystemReader(): FileSystemReader {
  return {
    async *readFileChunks(absolutePath, signal) {
      signal.throwIfAborted();
      const stream = createReadStream(absolutePath, { highWaterMark: 65_536, signal });
      try {
        for await (const chunk of stream) {
          signal.throwIfAborted();
          if (!(chunk instanceof Uint8Array)) throw new Error("unexpected_file_chunk");
          yield chunk;
        }
      } finally {
        stream.destroy();
      }
    },
    async readOptionalUtf8(absolutePath) {
      try {
        return await readFile(absolutePath, "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
    },
    async readFileUtf8(absolutePath: string, signal: AbortSignal): Promise<string> {
      if (signal.aborted) {
        throw new Error("aborted");
      }
      return readFile(absolutePath, { encoding: "utf8", signal });
    },
    async readFileUtf8Bounded(absolutePath, maxBytes, signal) {
      signal.throwIfAborted();
      const file = await open(absolutePath, "r");
      try {
        const buffer = Buffer.alloc(maxBytes + 1);
        let used = 0;
        while (used < buffer.length) {
          signal.throwIfAborted();
          const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
          if (bytesRead === 0) break;
          used += bytesRead;
        }
        signal.throwIfAborted();
        return used > maxBytes ? undefined : buffer.toString("utf8", 0, used);
      } finally {
        await file.close();
      }
    },
    // WP19.1 (C25/L10): raw bytes for media inputs; text readers stay text.
    async readFileBytes(absolutePath: string, signal: AbortSignal): Promise<Uint8Array> {
      if (signal.aborted) {
        throw new Error("aborted");
      }
      return new Uint8Array(await readFile(absolutePath, { signal }));
    },
    async readDir(absolutePath: string): Promise<ReadonlyArray<DirectoryEntry>> {
      const entries = await readdir(absolutePath, { withFileTypes: true });
      return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
    },
    async statBytes(absolutePath: string): Promise<number> {
      return (await stat(absolutePath)).size;
    },
  };
}
