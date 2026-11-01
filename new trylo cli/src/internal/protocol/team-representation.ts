export type TeamRepresentationVerdict = { readonly ready: true }
  | { readonly ready: false; readonly reason: string };

export type TeamRepresentation = { readonly intent: string; readonly vetoes: readonly string[];
  readonly user_questions: readonly string[]; readonly representation_notes: string };

export function isTeamRepresentation(value: unknown): value is TeamRepresentation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = ["intent", "vetoes", "user_questions", "representation_notes"];
  const items = (input: unknown): boolean => Array.isArray(input) && input.length <= 16
    && input.every(item => typeof item === "string" && item.trim().length > 0 && item.length <= 2000);
  return Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key))
    && typeof row.intent === "string" && row.intent.trim().length > 0 && row.intent.length <= 12000
    && typeof row.representation_notes === "string" && row.representation_notes.length <= 12000
    && items(row.vetoes) && items(row.user_questions) && Buffer.byteLength(JSON.stringify(row), "utf8") <= 48000;
}

/** Generated compatibility text, never model-authored delimiters or permission grants. */
export function formatTeamRepresentation(value: TeamRepresentation): string {
  const escape = (text: string): string => text.trim().replace(/^(\s*)#/gm, "$1\\#");
  const list = (items: readonly string[]): string => items.length === 0 ? "none" : items.map(item => `- ${escape(item).replace(/\r?\n/g, " ")}`).join("\n");
  return `### Intent\n${escape(value.intent)}\n\n### Veto\n${list(value.vetoes)}\n\n### User questions\n${list(value.user_questions)}\n\n### Representation notes\n${escape(value.representation_notes)}`;
}

/** Availability view of the existing Person output contract. Desktop's full
 * intent parser is mirrored at this boundary; a cross-surface fixture locks
 * headings, last-section precedence, veto markers and open-question behavior.
 */
export function inspectTeamRepresentation(output: string): TeamRepresentationVerdict {
  const sections = new Map<string, string[]>();
  let current: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const heading = /^#{2,3}\s*\*{0,2}(Intent|Veto|User questions|Representation notes)\b\*{0,2}\s*$/i.exec(line.trim());
    if (heading) {
      current = heading[1]!.toLowerCase();
      sections.set(current, []);
    } else if (current !== undefined) sections.get(current)!.push(line);
  }
  if (!["intent", "veto", "user questions", "representation notes"].every(title => sections.has(title))) {
    return { ready: false, reason: "Person must report Intent, Veto, User questions and Representation notes before implementation" };
  }
  const veto = sections.get("veto")!.join("\n").trim();
  if (veto !== "" && !/^(none|`none`|无)$/i.test(veto)) {
    return { ready: false, reason: `Person veto: ${veto.slice(0, 240)}` };
  }
  const questions = sections.get("user questions")!.join("\n").trim();
  if (!/^(none|empty|无)?$/i.test(questions)) {
    return { ready: false, reason: `Person requires clarification: ${questions.slice(0, 240)}` };
  }
  return { ready: true };
}
