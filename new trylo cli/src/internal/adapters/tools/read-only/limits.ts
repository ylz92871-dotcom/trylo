/**
 * The shapes the read-only tools are made of: what a file system hands back, and
 * the ceilings every one of them is held to.
 *
 * Split out of `index.ts` so `bindings.ts` can state a tool's output limits
 * without importing the dispatcher that uses them — which would be a cycle, and a
 * cycle is the kind of thing that gets worked around later by widening an
 * exception list instead of moving a file.
 *
 * The ceilings are defaults with names, not literals sprinkled at call sites,
 * because they are a contract in both directions: a model is told the first read
 * is 2000 lines (`read_file`'s description says so), and a test that pins the
 * number here is pinning the same promise the description makes.
 */

export type DirectoryEntry = {
  readonly name: string;
  readonly isDirectory: boolean;
};

export type FileSystemReader = {
  /** Missing ignore files are normal; other read failures remain visible. */
  readOptionalUtf8?(absolutePath: string): Promise<string | undefined>;
  readFileUtf8(absolutePath: string, signal: AbortSignal): Promise<string>;
  /** Bounded byte chunks; the consumer owns decoding and releases the iterator on cancellation. */
  readFileChunks?(absolutePath: string, signal: AbortSignal): AsyncIterable<Uint8Array>;
  /** Undefined means oversized. Implementations must retain at most maxBytes + 1 raw bytes. */
  readFileUtf8Bounded?(absolutePath: string, maxBytes: number, signal: AbortSignal): Promise<string | undefined>;
  /**
   * Raw bytes for media inputs (WP19.1: C25, L10). Optional so every existing
   * text-only reader keeps compiling; a reader without it makes `view_image`
   * fail closed with `bytes_unavailable` instead of decoding text as an image.
   */
  readFileBytes?(absolutePath: string, signal: AbortSignal): Promise<Uint8Array>;
  readDir(absolutePath: string): Promise<ReadonlyArray<DirectoryEntry>>;
  statBytes(absolutePath: string): Promise<number>;
};

export type ReadOnlyToolLimits = {
  readonly maxBytes: number;
  readonly maxLines: number;
  readonly maxSearchFiles: number;
  readonly maxSearchMatches: number;
  readonly maxSearchDepth: number;
  /** Optional so an existing caller's literal keeps compiling; defaults below. */
  readonly maxListEntries?: number;
  readonly maxSearchFileBytes?: number;
};

export const DEFAULT_MAX_SEARCH_FILE_BYTES = 1_048_576;

export const DEFAULT_READ_ONLY_LIMITS: ReadOnlyToolLimits = {
  maxBytes: 65_536,
  maxLines: 2_000,
  maxSearchFiles: 500,
  maxSearchMatches: 100,
  maxSearchDepth: 6,
  maxListEntries: 200,
  maxSearchFileBytes: DEFAULT_MAX_SEARCH_FILE_BYTES,
};

/** Names a listing will not show, counted and reported instead of dropped. */
export const DEFAULT_MAX_LIST_ENTRIES = 200;
