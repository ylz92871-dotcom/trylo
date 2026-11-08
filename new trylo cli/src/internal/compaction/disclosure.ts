/**
 * Credential and path disclosure scanning for material that leaves the process:
 * compaction summaries first, checkpoint manifests second.
 *
 * One definition, because "contains an absolute path" cannot mean one thing in
 * the summary and a looser thing in the manifest without the looser one
 * becoming the real contract.
 *
 * Findings carry a kind and an offset, never the matched text. Printing the
 * offending substring into a diagnosis would defeat the point of refusing it.
 */

export type DisclosureRiskKind = "absolute_path" | "secret_shape";

export type DisclosureRisk = {
  readonly kind: DisclosureRiskKind;
  /** Character offset of the match, for humans who must edit the source. */
  readonly index: number;
};

const WINDOWS_PATH = /[A-Za-z]:\\[^\s"']+/g;
const POSIX_PATH = /\/(?:home|Users|tmp|var|etc|usr|root|opt|srv)\/[^\s"']+/g;
const HOME_PATH = /(?:~|\$HOME)(?:\/|\\)[^\s"']*/g;
const SECRET_SHAPE =
  /(?:sk-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|password|secret|token|bearer)\s*[:=]\s*\S+)/gi;

type Scanner = { readonly kind: DisclosureRiskKind; readonly pattern: RegExp };

/** Built fresh per call: a shared `g` regex would carry `lastIndex` across inputs. */
function scanners(): readonly Scanner[] {
  return [
    { kind: "absolute_path", pattern: new RegExp(WINDOWS_PATH) },
    { kind: "absolute_path", pattern: new RegExp(POSIX_PATH) },
    { kind: "absolute_path", pattern: new RegExp(HOME_PATH) },
    { kind: "secret_shape", pattern: new RegExp(SECRET_SHAPE) },
  ];
}

export function findDisclosureRisks(text: string): readonly DisclosureRisk[] {
  const found: DisclosureRisk[] = [];

  for (const scanner of scanners()) {
    for (const match of text.matchAll(scanner.pattern)) {
      found.push({ kind: scanner.kind, index: match.index ?? 0 });
    }
  }

  return found.sort((left, right) => left.index - right.index);
}

/**
 * Replaces findings rather than deleting whole lines: a summary that loses its
 * subject line is useless, whereas a summary that says `[path]` still reads.
 */
export function scrubDisclosure(text: string): string {
  let scrubbed = text;
  for (const scanner of scanners()) {
    scrubbed = scrubbed.replace(scanner.pattern, scanner.kind === "absolute_path" ? "[path]" : "[secret]");
  }
  return scrubbed;
}

export function hasDisclosureRisk(text: string): boolean {
  return findDisclosureRisks(text).length > 0;
}
