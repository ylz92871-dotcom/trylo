import type { BurstDecision } from "./paste-burst.js";
import type { ComposerBuffer } from "./composer-buffer.js";

/**
 * How burst decisions become buffer edits and submissions (WP23.2 / C81).
 *
 * The burst machine (`paste-burst.ts`) classifies; this module applies. Two
 * entry points mirror the two key kinds that reach it: characters, and Enter.
 *
 * Enter is where paste protection earns its keep. The burst machine's answer
 * for Enter is one of: a flushed buffer it called a paste (the Enter ended the
 * paste — the buffer gets the text, the submission does not happen), a flushed
 * buffer that was *not* paste-like (ordinary fast typing — the text joins the
 * buffer and the Enter still submits), an empty flush (a suppressed Enter —
 * the paste's own trailing newline joins the buffer), or a plain submit.
 */

export type PasteOps = {
  readonly buffer: ComposerBuffer;
  readonly submit: () => void;
};

/** Characters (or bracketed pastes, or flushes) that were not Enter. */
export function applyBurstDecisions(list: ReadonlyArray<BurstDecision>, ops: PasteOps): void {
  for (const decision of list) {
    if (decision.kind === "pass") {
      ops.buffer.insert(decision.text);
      continue;
    }
    if (decision.kind === "flushed") {
      if (decision.isPaste) {
        ops.buffer.acceptPaste(decision.text);
      } else {
        ops.buffer.insert(decision.text);
      }
    }
  }
}

/** The Enter key, once the burst machine has had its say. */
export function applyBurstEnter(list: ReadonlyArray<BurstDecision>, ops: PasteOps): void {
  let submitRequested = false;

  for (const decision of list) {
    if (decision.kind === "pass") {
      ops.buffer.insert(decision.text);
      continue;
    }

    if (decision.kind === "submit") {
      submitRequested = true;
      continue;
    }

    if (decision.kind === "flushed") {
      if (decision.text.length > 0) {
        if (decision.isPaste) {
          ops.buffer.acceptPaste(decision.text);
        } else {
          ops.buffer.insert(decision.text);
          submitRequested = true;
        }
      } else {
        ops.buffer.insert("\n");
      }
    }
  }

  if (submitRequested) {
    // The continuation convention the whole build shares (see `multiline.ts`):
    // a single trailing backslash asks for another line instead of a
    // submission.
    if (ops.buffer.endsWithContinuation()) {
      ops.buffer.takeContinuation();
      return;
    }
    ops.submit();
  }
}
