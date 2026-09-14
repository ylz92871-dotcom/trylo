// Person seat output parser (PR-5, spec §10.3).
//
// The Person seat must end with `Intent` / `Veto` / `User questions` /
// `Representation notes` headings (person.ts preamble). This parser is
// the only reader of that output; fail closed: any missing heading →
// null (drift is unreliable), and a null result is never treated as a
// veto. The same algorithm is copied to
// `trylo cli/src/tools/AgentTool/team-roster/person-output.ts` — desktop
// must not import CLI sources; a fixture test locks both copies.

export interface PersonSeatOutput {
  readonly intent: {
    readonly explicit: string;
    readonly inferred: string;
    readonly unknown: string;
  };
  readonly veto: { readonly active: false } | {
    readonly active: true;
    readonly reason: string;
    readonly contractField: string;
  };
  readonly userQuestions: readonly string[];
  readonly representationNotes: string;
}

const SECTION_TITLES = ['Intent', 'Veto', 'User questions', 'Representation notes'] as const;

type SectionTitle = (typeof SECTION_TITLES)[number];

const SECTION_PATTERNS: Readonly<Record<SectionTitle, RegExp>> = {
  Intent: /^#{2,3}\s*\*{0,2}Intent\b\*{0,2}\s*$/i,
  Veto: /^#{2,3}\s*\*{0,2}Veto\b\*{0,2}\s*$/i,
  'User questions': /^#{2,3}\s*\*{0,2}User questions\b\*{0,2}\s*$/i,
  'Representation notes': /^#{2,3}\s*\*{0,2}Representation notes\b\*{0,2}\s*$/i,
};

function sectionBody(text: string, title: SectionTitle): string | null {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (SECTION_PATTERNS[title].test(lines[i]!.trim())) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    if (SECTION_TITLES.some((t) => SECTION_PATTERNS[t].test(trimmed))) break;
    body.push(lines[i]!);
  }
  return body.join('\n').trim();
}

const MAX_VETO_REASON = 240;
const MAX_NOTES = 500;

function parseIntent(body: string): PersonSeatOutput['intent'] {
  const line = (label: string): string | undefined => {
    const m = body.match(new RegExp(`-\\s*${label}\\s*:\\s*(.+)`, 'i'));
    return m?.[1]?.trim();
  };
  return {
    explicit: line('explicit') ?? 'none stated',
    inferred: line('inferred') ?? 'none',
    unknown: line('unknown') ?? 'none',
  };
}

function parseVeto(body: string): PersonSeatOutput['veto'] {
  const normalized = body.trim();
  if (normalized === '' || /^(none|`none`|无)$/i.test(normalized)) {
    return { active: false };
  }
  const dotted = normalized.match(/(explicit|inferred|baseline|recommendation)\.\w+/i);
  const field = normalized.match(/field\s*=\s*(\w+)/i);
  return {
    active: true,
    reason: normalized.length <= MAX_VETO_REASON ? normalized : `${normalized.slice(0, MAX_VETO_REASON - 1)}…`,
    contractField: dotted?.[0] ?? field?.[1] ?? 'unspecified',
  };
}

const EMPTY_QUESTIONS = /^(none|empty|无)?$/i;

function parseQuestions(body: string): readonly string[] {
  if (body === '' || EMPTY_QUESTIONS.test(body.trim())) return [];
  const bullets = [...body.matchAll(/^\s*[-*]\s+(.+)$/gm)].map((m) => m[1]!.trim());
  if (bullets.length > 0) return bullets;
  return [body.trim()];
}

/** Parse a Person seat result. null = unparsable; never a veto. */
export function parsePersonSeatOutput(text: string): PersonSeatOutput | null {
  const intent = sectionBody(text, 'Intent');
  const veto = sectionBody(text, 'Veto');
  const questions = sectionBody(text, 'User questions');
  const notes = sectionBody(text, 'Representation notes');
  if (intent === null || veto === null || questions === null || notes === null) return null;
  return {
    intent: parseIntent(intent),
    veto: parseVeto(veto),
    userQuestions: parseQuestions(questions),
    representationNotes: notes.length <= MAX_NOTES ? notes : `${notes.slice(0, MAX_NOTES - 1)}…`,
  };
}

export function isVetoActive(out: PersonSeatOutput): boolean {
  return out.veto.active;
}
