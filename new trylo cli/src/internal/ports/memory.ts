/**
 * Memory retrieval, as a port (WP20.3: C60 / L51).
 *
 * What "memory" means here is deliberately narrow, because the word is doing
 * too much work in most designs. This port reads **records Trylo already
 * persisted** — the learning board's activated assets and the project rule
 * files a run adopted — and hands back matching lines. It does not decide what
 * is worth remembering, does not write, and does not promote anything into an
 * asset. Learning sedimentation and asset governance stay exactly where they
 * are: in the learning control plane, behind its own writer.
 *
 * That boundary is why this is a read port over an injected document source
 * rather than a second store. Codex's `memories` extension keeps its own
 * directory and its own `add_ad_hoc_note` writer; copying that shape here would
 * put a second writer next to the board and give the run two answers to "what
 * did I learn". Only the retrieval leaves are reused: the match modes, the
 * context window, the cursor pagination and the explicit truncation flag.
 *
 * Every failure is a value. A memory read that cannot be satisfied says which
 * of the three things went wrong — the document is gone, the cursor is not one
 * of ours, or the query is empty — because a search that silently returned
 * nothing would be indistinguishable from "this run has no memory", and a model
 * cannot tell those apart.
 */

export const MEMORY_MATCH_MODES = ["any", "all_on_same_line", "all_within_lines"] as const;

export type MemoryMatchMode = (typeof MEMORY_MATCH_MODES)[number];

export function isMemoryMatchMode(value: string): value is MemoryMatchMode {
  return (MEMORY_MATCH_MODES as readonly string[]).includes(value);
}

/**
 * One searchable record.
 *
 * `id` is the document's own stable identity (a board version id, a rule file's
 * workspace-relative path) rather than a path this port invented, so a result a
 * model cites can be traced back to the record that produced it.
 */
export type MemoryDocument = {
  readonly id: string;
  /** Absolute path, carried so `memory_read` can address the same bytes again. */
  readonly path: string;
  readonly lines: ReadonlyArray<string>;
  /** Where the record came from, stated in results rather than implied. */
  readonly origin: string;
  /** Optional source-owned category; untagged legacy documents remain searchable. */
  readonly recordKind?: string;
};

export type MemoryDocuments = {
  readonly documents: ReadonlyArray<MemoryDocument>;
};

export type MemorySearchRequest = {
  readonly queries: ReadonlyArray<string>;
  readonly matchMode: MemoryMatchMode;
  /** How many lines of context each hit carries. Zero means the hit line only. */
  readonly contextLines: number;
  readonly caseSensitive: boolean;
  /**
   * Compare with separators and punctuation removed, so `read-file` and
   * `read file` are the same query. It is a second case-folding step, not a
   * fuzzy matcher: it never reorders or approximates, so it cannot invent a hit.
   */
  readonly normalized: boolean;
  readonly maxResults: number;
  readonly cursor?: string;
  /** Only consider this document, when the caller names one. */
  readonly documentId?: string;
  readonly recordKind?: string;
};

export type MemoryMatch = {
  readonly documentId: string;
  readonly path: string;
  readonly origin: string;
  readonly recordKind?: string;
  /** 1-indexed, as the reader sees it. */
  readonly matchLineNumber: number;
  readonly contentStartLineNumber: number;
  readonly content: string;
  readonly matchedQueries: ReadonlyArray<string>;
};

export type MemorySearchResult = {
  readonly queries: ReadonlyArray<string>;
  readonly matches: ReadonlyArray<MemoryMatch>;
  /** Absent when the page was the last one. Present means "ask again with this". */
  readonly nextCursor?: string;
  readonly truncated: boolean;
};

export type MemoryReadRequest = {
  readonly documentId: string;
  /** 1-indexed, so `line_offset: 1` is the first line and not a silent skip. */
  readonly lineOffset: number;
  readonly maxLines?: number;
};

export type MemoryReadResult = {
  readonly documentId: string;
  readonly path: string;
  readonly origin: string;
  readonly startLineNumber: number;
  readonly content: string;
  readonly totalLines: number;
  readonly truncated: boolean;
};

export const MEMORY_FAILURE_CODES = [
  "source_unavailable",
  "unknown_document",
  "not_a_document",
  "empty_query",
  "invalid_cursor",
  "invalid_line_offset",
  "invalid_match_window",
  "cancelled",
] as const;

export type MemoryFailureCode = (typeof MEMORY_FAILURE_CODES)[number];

export type MemoryFailure = {
  readonly ok: false;
  readonly code: MemoryFailureCode;
  readonly message: string;
};

export type MemoryOutcome<T> = ({ readonly ok: true } & T) | MemoryFailure;

/**
 * The injected document source.
 *
 * A function rather than a store object: the caller already knows how to read
 * its own records (the board reader, the project-rule reader), and handing this
 * port a `readAll()` would mean the memory tools owned a second reading path
 * over the same bytes.
 */
export type MemoryDocumentSource = () => Promise<MemoryDocuments>;

export type MemoryReadPort = {
  /** Which records exist right now. Read per call, so a new record is visible. */
  readonly documents: MemoryDocumentSource;
  search(request: MemorySearchRequest, signal: AbortSignal): Promise<MemoryOutcome<MemorySearchResult>>;
  read(request: MemoryReadRequest, signal: AbortSignal): Promise<MemoryOutcome<MemoryReadResult>>;
};

export function memoryFailure(code: MemoryFailureCode, message: string): MemoryFailure {
  return { ok: false, code, message };
}
