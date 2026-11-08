import { cutToBytes } from "../text-cut.js";
import type { ProjectInstruction } from "./instruction-reader.js";

export type LocalRuleNote = {
  readonly relativePath: string;
  readonly scopePath: string;
  readonly scope: ProjectInstruction["scope"];
  readonly contentHash: string;
  readonly text: string;
};

/** Provenance recorded by the existing session writer, without repeating rule bodies. */
export type LocalRuleSource = Omit<LocalRuleNote, "text">;

export type LocalRuleLookup = (targetAbsolutePath: string) => ReadonlyArray<LocalRuleNote>;

export type LocalRuleAppendix = {
  readonly text: string;
  readonly sources: ReadonlyArray<LocalRuleSource>;
  readonly omittedFiles: number;
  readonly bodyTruncated: boolean;
};

const BEGIN = "--- project rules for this file (not part of the code above) ---";
const END = "--- end project rules ---";
export const MAX_LOCAL_RULE_BYTES = 16 * 1024;

export function localRuleAppendix(rules: ReadonlyArray<LocalRuleNote>, byteBudget: number): LocalRuleAppendix {
  const sources = rules.map(({ relativePath, scopePath, scope, contentHash }) => ({ relativePath, scopePath, scope, contentHash }));

  if (rules.length === 0 || byteBudget <= 0) {
    return { text: "", sources, omittedFiles: rules.length, bodyTruncated: false };
  }

  const omission = `[${rules.length} more rule file(s) for this path did not fit in the output budget; read them directly]`;
  const footerReserve = Buffer.byteLength(END + "\n\n" + omission + "\n\n", "utf8");
  const lines = [BEGIN];
  let used = Buffer.byteLength(BEGIN, "utf8") + 2;
  if (used + footerReserve > byteBudget) {
    return { text: cutToBytes(omission, byteBudget), sources, omittedFiles: rules.length, bodyTruncated: false };
  }

  let served = 0;
  let bodyTruncated = false;

  for (const rule of rules) {
    const header = `From ${rule.relativePath} (applies to ${rule.scopePath}/ and below, content ${rule.contentHash}):`;
    const room = byteBudget - used - footerReserve;
    const headerCost = Buffer.byteLength(`${header}\n\n`, "utf8");
    if (room <= headerCost) break;

    // Reserve the cut notice before selecting the body; diagnostics share the same byte budget.
    const notice = `\n[rule body cut here: ${rule.text.length} more characters of ${rule.relativePath}; read that file directly for the rest]`;
    const complete = Buffer.byteLength(rule.text, "utf8") <= room - headerCost;
    const body = complete ? rule.text : cutToBytes(rule.text, room - headerCost - Buffer.byteLength(notice, "utf8"));
    const tail = complete ? "" : notice.replace(String(rule.text.length) + " more", String(rule.text.length - body.length) + " more");
    if (!complete && headerCost + Buffer.byteLength(tail, "utf8") > room) break;

    bodyTruncated ||= !complete;
    const block = `${header}\n\n${body}${tail}`;

    lines.push(block);
    used += Buffer.byteLength(block, "utf8") + 2;
    served += 1;
  }

  const omittedFiles = rules.length - served;
  if (omittedFiles > 0) lines.push(omission.replace(String(rules.length) + " more", String(omittedFiles) + " more"));

  lines.push(END);

  return { text: lines.join("\n\n"), sources, omittedFiles, bodyTruncated };
}
