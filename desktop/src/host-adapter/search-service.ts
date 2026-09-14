// Trylo Desktop — SearchService interface. See ARCHITECTURE.md §2.4
// (monaco-vcode-api search service override — Ctrl+Shift+F) +
// §3 Phase 0 Day 6 + Week 2 Day 2.
//
// Per arch doc §2.4, the search service is "ripgrep-backed". The
// spike shells out to `rg` from Rust (see `commands/search.rs`).
// The TS side forwards the call with optional regex / case
// toggles.

import type { FilePath } from './types';

export interface SearchMatch {
  readonly path: FilePath;
  readonly line: number;
  readonly content: string;
}

export interface SearchOptions {
  /** Treat the query as a regex. Default false (literal substring). */
  readonly regex: boolean;
  /** Case-insensitive match. Default false. */
  readonly caseInsensitive: boolean;
}

export interface SearchService {
  search(
    query: string,
    path: FilePath,
    options: SearchOptions,
  ): Promise<readonly SearchMatch[]>;
}
