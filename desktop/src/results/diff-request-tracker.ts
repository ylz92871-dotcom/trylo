// Trylo Desktop — Git diff request identity tracker (P2-1 C-Core, audit P2-1).
//
// The diff right-pane is filled ASYNCHRONOUSLY via `hostAdapter.git.fileDiff`.
// A path-only identity is not enough: while a request is in flight the user
// can switch workspace, switch session, or open a newer diff — and the stale
// response would otherwise overwrite the panel with the wrong content.
//
// This module owns the generation / identity rules so React never juggles
// them inline:
//
//   * every request mints a NEW generation (`requestId`) — opening a newer
//     diff implicitly invalidates every older one;
//   * a response may land ONLY while its FULL identity is still current
//     (requestId + workspaceRoot + conversationId + path + oldPath);
//   * workspace switch / session switch / explicit close call `invalidate()`
//     so nothing in flight can land afterwards;
//   * the rename source (`oldPath`) IS part of the identity — two diffs of
//     the same target path but different rename origins are different
//     requests.
//
// Pure module: no React, no Tauri — fully unit-testable.

/** Complete identity of one diff request. Equality is field-by-field; the
 *  `requestId` doubles as the generation token. */
export interface DiffRequestIdentity {
  /** Unique per request; doubles as the generation token. */
  readonly requestId: string;
  /** Workspace root the diff was requested against. */
  readonly workspaceRoot: string;
  /** Conversation (session) whose result dock issued the request. */
  readonly conversationId: string;
  /** Repo-relative path of the changed file (diff right side). */
  readonly path: string;
  /** Rename / copy SOURCE — part of the identity, not a display hint. */
  readonly oldPath?: string;
}

/** Single-flight tracker for the diff panel. At most one request is
 *  "current"; starting a new one or invalidating drops every older
 *  generation. */
export class DiffRequestTracker {
  private current: DiffRequestIdentity | null = null;
  private generation = 0;

  /** Start a NEW request. Implicitly invalidates every previous one (the
   *  newer diff wins). Returns the identity the caller must echo back when
   *  the response arrives. */
  begin(
    workspaceRoot: string,
    conversationId: string,
    path: string,
    oldPath?: string,
  ): DiffRequestIdentity {
    this.generation += 1;
    const identity: DiffRequestIdentity = {
      requestId: `diff-${this.generation.toString(36)}`,
      workspaceRoot,
      conversationId,
      path,
      ...(oldPath !== undefined ? { oldPath } : {}),
    };
    this.current = identity;
    return identity;
  }

  /** Response guard: `true` only while this exact identity is still the
   *  current request. Any mismatch — stale generation, workspace switch,
   *  session switch, different rename origin — returns `false` and the
   *  response must be dropped, never applied. */
  isCurrent(identity: DiffRequestIdentity): boolean {
    const c = this.current;
    return (
      c !== null
      && c.requestId === identity.requestId
      && c.workspaceRoot === identity.workspaceRoot
      && c.conversationId === identity.conversationId
      && c.path === identity.path
      && (c.oldPath ?? '') === (identity.oldPath ?? '')
    );
  }

  /** Explicit invalidation: workspace switch, session switch, panel close.
   *  In-flight responses stop being applicable immediately. */
  invalidate(): void {
    this.current = null;
  }

  /** The request currently owning the panel, if any (diagnostics/tests). */
  get active(): DiffRequestIdentity | null {
    return this.current;
  }
}
