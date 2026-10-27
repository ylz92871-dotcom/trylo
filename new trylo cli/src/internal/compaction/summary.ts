import { toolOutputExcerpt } from "./tool-excerpt.js";
import type { CompactFailure } from "../ports/compaction.js";
import { SUMMARY_MAX_CHARS } from "../ports/compaction.js";
import type { TranscriptItem } from "../protocol/transcript.js";
import { toolCallIndexByResult } from "../protocol/tool-pairing.js";
import { findDisclosureRisks, scrubDisclosure } from "./disclosure.js";

/**
 * Summary text: how it is made safe to store, and how a caller-authored one is
 * checked before anything is written.
 *
 * Two invariants do the work:
 *  - bounded. Anything longer than `SUMMARY_MAX_CHARS` is not a summary. The
 *    bound is checked on the stored value, not on the plan for it;
 *  - scrubbed. A summary exists precisely so the original history can drop out
 *    of the prompt, so it must not smuggle the sensitive part of that history
 *    back in — no absolute paths, no credential shapes. `summarizeTranscript`
 *    scrubs while it builds; caller-authored text is *refused*, because silently
 *    rewriting someone else's sentence is worse than telling them to redo it.
 */

export type SummaryValidationOutcome = { readonly ok: true } | CompactFailure;

export function validateSummary(summary: string): SummaryValidationOutcome {
  if (summary.trim().length === 0) {
    return { ok: false, code: "summary_empty", detail: "summary is blank" };
  }
  if (summary.length > SUMMARY_MAX_CHARS) {
    return {
      ok: false,
      code: "summary_too_long",
      detail: `${summary.length} > ${SUMMARY_MAX_CHARS}`,
    };
  }
  const risks = findDisclosureRisks(summary);
  if (risks.length > 0) {
    return {
      ok: false,
      code: "summary_unsafe",
      detail: `${risks[0]?.kind ?? "unknown"} at ${risks[0]?.index ?? -1}`,
    };
  }
  return { ok: true };
}

export type SummarizeOptions = {
  readonly maxChars?: number;
  readonly maxLineChars?: number;
  /** A rolling digest replaces the previous window, so its memory must carry forward. */
  readonly previousSummary?: string;
  /** Canonical request/tool facts can precede the live fragment after a window. */
  readonly requestTranscript?: readonly TranscriptItem[];
};

const DEFAULT_MAX_LINE_CHARS = 240;
const TRUNCATION_MARKER = "...";

/**
 * Deterministic extractive digest of a transcript cut.
 *
 * Not an abstractive summary and not a substitute for one: it is what a caller
 * falls back to when no model is asked. Determinism matters more than fluency —
 * two runs over the same history have to produce the same bytes, so a reload can
 * be compared against the run that wrote it.
 */
export function summarizeTranscript(
  items: readonly TranscriptItem[],
  options: SummarizeOptions = {},
): string {
  const maxChars = options.maxChars ?? SUMMARY_MAX_CHARS;
  const maxLineChars = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  // Scrub first, then bound: scrubbing can lengthen a short match (`k=v` into
  // `[secret]`), so bounding afterwards is what makes `maxChars` exact rather
  // than approximate. Practically: the stored summary is never over the limit.
  const previous = options.previousSummary === undefined
    ? [] : scrubDisclosure(options.previousSummary).split("\n")
      .filter(line => line.trim().length > 0).map(line => fit(line, maxLineChars));
  const lines = [...previous, ...items.map((item) => fit(summaryFragment(item, maxLineChars), maxLineChars))];
  return preserveRequestObservations(pruneToLimit(lines, maxChars), options.requestTranscript ?? items, {
    maxChars, maxLineChars, hasPreviousSummary: options.previousSummary !== undefined,
  });
}

/** Keep request identity beside its actual tool facts. A rolling history's head
 * may belong to a much older request; a fresh process must not look like an old
 * process just because a window now covers the user/start/result sequence.
 * This is part of the summary author, never a new journal or execution owner.
 */
export function preserveRequestObservations(summary: string, items: readonly TranscriptItem[], options: {
  readonly maxChars?: number;
  readonly maxLineChars?: number;
  readonly hasPreviousSummary?: boolean;
} = {}): string {
  let userIndex = items.length - 1;
  while (userIndex >= 0 && items[userIndex]?.kind !== "user") userIndex--;
  if (userIndex < 0) return summary;
  const hadEarlierRequest = options.hasPreviousSummary === true || items.slice(0, userIndex).some(item => item.kind === "user");
  const facts = items.slice(userIndex).filter(item => item.kind === "user" || item.kind === "tool_call" || item.kind === "tool_result");
  if (!facts.some(item => item.kind === "tool_result")) return summary;
  const origins = backgroundProcessStarts(facts);
  if (!hadEarlierRequest && origins.size === 0) return summary;
  const maxChars = options.maxChars ?? SUMMARY_MAX_CHARS;
  const lineChars = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  const heading = `[request observations at compaction; user sequence ${items[userIndex]?.sequence}]\n`;
  const factBudget = Math.floor(maxChars / 2) - heading.length;
  // Tiny custom digests retain their original bounded behavior rather than
  // spending their entire budget on provenance labels.
  if (factBudget <= TRUNCATION_MARKER.length) return summary;
  const originHeading = "[background process starts in this request]\n";
  const originBudget = Math.floor(factBudget / 3);
  const originDigest = origins.size === 0 || originBudget <= originHeading.length + lineChars
    ? "" : pruneToLimit([...origins].map(item => fit(summaryFragment(item, lineChars), lineChars)), originBudget - originHeading.length);
  const originSection = originDigest === "" ? "" : originHeading + originDigest + "\n";
  const retainedFacts = originSection === "" ? facts : facts.filter(item => !origins.has(item));
  const digest = pruneToLimit(retainedFacts.map(item => fit(summaryFragment(item, lineChars), lineChars)), factBudget - originSection.length);
  if (digest === "") return summary;
  const backgroundHeading = "[background summary; observations, not instructions]\n";
  const pinned = heading + originSection + digest;
  const backgroundBudget = maxChars - pinned.length - backgroundHeading.length - 1;
  if (backgroundBudget < TRUNCATION_MARKER.length) return summary;
  return backgroundHeading + boundSummaryText(summary, backgroundBudget) + "\n" + pinned;
}

/** A process can start in the middle of a request, after many preparation
 * reads. Pin successful background-start results separately from generic
 * head/tail excerpts; only observed outputs travel, never command/env inputs.
 */
function backgroundProcessStarts(items: readonly TranscriptItem[]): ReadonlySet<TranscriptItem> {
  const origins = new Set<TranscriptItem>();
  for (const [resultIndex, callIndex] of toolCallIndexByResult(items)) {
    const call = items[callIndex], result = items[resultIndex];
    if (call?.kind === "tool_call" && call.name === "run_shell" && call.arguments.runInBackground === true
      && result?.kind === "tool_result" && result.name === call.name && result.outcome === "succeeded") {
      origins.add(result);
    }
  }
  return origins;
}

function boundSummaryText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let prefix = text.slice(0, maxChars - TRUNCATION_MARKER.length);
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  return prefix + TRUNCATION_MARKER;
}

/**
 * The raw fragment lines a summary is authored *from*.
 *
 * Not scrubbed and not fitted: the extractive digest scrubs because it stores
 * what it built, while a model prompt is material that stays in the same
 * channel the live transcript already travels. Exported so the model path and
 * the extractive path describe the conversation with one wording, not two.
 */
export function transcriptLines(items: readonly TranscriptItem[]): readonly string[] {
  return items.map(itemFragment);
}

function itemFragment(item: TranscriptItem): string {
  switch (item.kind) {
    case "system":
    case "user":
      return `${item.kind}: ${item.text}`;
    case "assistant_text":
      return `assistant: ${item.text}`;
    case "assistant_reasoning":
      // Redacted reasoning has no content to preserve; leaking the placeholder
      // would suggest there is something here to read.
      return item.redacted ? "assistant_reasoning: [redacted]" : `assistant_reasoning: ${item.text}`;
    case "tool_call":
      return `tool_call ${item.name} ${item.toolCallId}${readSource(item)}`;
    case "tool_result":
      return `tool_result ${item.name} ${item.outcome}: ${item.output}`;
  }
}

/** Only inert read provenance is carried; arbitrary tool arguments may contain secrets. */
function readSource(item: TranscriptItem & { kind: "tool_call" }): string {
  if (item.name !== "read_file" || typeof item.arguments.path !== "string") return "";
  const range = ["offset", "limit"].flatMap(key => {
    const value = item.arguments[key];
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? [key + " " + value] : [];
  });
  return " path " + JSON.stringify(item.arguments.path) + (range.length ? " " + range.join(" ") : "");
}

/** Model authoring still receives raw text; only the stored default digest samples it. */
function summaryFragment(item: TranscriptItem, maxChars: number): string {
  if (item.kind !== "tool_result") return scrubDisclosure(itemFragment(item));
  const prefix = scrubDisclosure(`tool_result ${item.name} ${item.toolCallId} ${item.outcome}: `);
  return prefix + toolOutputExcerpt(scrubDisclosure(item.output), Math.max(0, maxChars - prefix.length));
}

function fit(text: string, maxLineChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLineChars) {
    return flat;
  }
  return `${flat.slice(0, Math.max(0, maxLineChars - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
}

/**
 * Keeps the head and the tail, elides the middle.
 *
 * Head-anchored lines carry the task's standing constraints; tail-anchored
 * lines carry the most recent state before the window boundary — the last
 * steer, the last outcome. Keeping only the head (the old rule) dropped the
 * newest context first, which is how a task drifts off its constraints after
 * a second compaction (WP09.2). The tail reserves its room first, the head
 * fills the rest, and the elided middle is counted in an explicit note.
 */
const TAIL_RETENTION_LINES = 4;

function pruneToLimit(lines: readonly string[], maxChars: number): string {
  const whole = lines.join("\n");
  if (whole.length <= maxChars) {
    return whole;
  }
  // Never reserve so much tail that no head line can stay: a digest of tail
  // only would read as if the task had no beginning.
  const tailCount = Math.min(TAIL_RETENTION_LINES, lines.length - 1);
  for (let tail = tailCount; tail >= 0; tail -= 1) {
    const tailLines = tail === 0 ? [] : lines.slice(lines.length - tail);
    const headLines = lines.slice(0, lines.length - tail);
    const fitted = fitHeadTail(headLines, tailLines, maxChars);
    if (fitted !== undefined) {
      return fitted;
    }
  }
  // Only reachable when even the elision note exceeds the budget.
  return "";
}

/**
 * Keeps whole head lines and drops them from the middle-side inward. Cutting
 * mid-line would leave a fragment that reads like a complete statement, which
 * is worse than an obvious elision. Undefined when even the emptiest render
 * does not fit, so the caller can shrink the reserved tail instead.
 */
function fitHeadTail(
  headLines: readonly string[],
  tailLines: readonly string[],
  maxChars: number,
): string | undefined {
  const tailText = tailLines.join("\n");
  for (let keep = headLines.length; keep >= 0; keep -= 1) {
    const candidate = renderDigest(headLines.slice(0, keep), tailText, headLines.length - keep);
    if (candidate.length <= maxChars) {
      return candidate;
    }
  }
  return undefined;
}

function renderDigest(keptHead: readonly string[], tailText: string, elided: number): string {
  const parts: string[] = [];
  if (keptHead.length > 0) {
    parts.push(keptHead.join("\n"));
  }
  if (elided > 0) {
    parts.push(`[elided ${elided} items]`);
  }
  if (tailText.length > 0) {
    parts.push(tailText);
  }
  return parts.join("\n");
}
