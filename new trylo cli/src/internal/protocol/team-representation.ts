export type TeamRepresentationVerdict = { readonly ready: true }
  | { readonly ready: false; readonly reason: string };

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
