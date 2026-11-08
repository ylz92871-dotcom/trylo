import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { loadSessionMeta, SESSION_JOURNAL_SUFFIX } from "../../adapters/session-store/session-meta.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { isTranscriptItem } from "../../protocol/transcript.js";
import type { CliContext } from "./context.js";
import { aligned, humanBytes, limited, LIST_LIMIT, relativeTime } from "./humanize.js";
import { reportFailure } from "./run-failure.js";
import { isValidSessionId, listSessions, sessionsDir } from "./session-paths.js";

/**
 * WP02.1 session listing: which sessions exist, what they are called, and
 * whether their journals still read.
 *
 * The directory listing stays the fast path (name/size/mtime only); each row
 * is then enriched from the sidecar (display name, archive flag) and from a
 * lock-free journal read (first-prompt preview, readability). An unreadable
 * journal or sidecar marks its row instead of dropping the list — a damaged
 * file with no visible result is how sessions get lost.
 */

export type SessionHealth = "ok" | "missing" | "torn-tail" | "preview-omitted" | `unreadable:${string}`;

export type EnrichedSession = {
  readonly id: string;
  readonly bytes: number;
  readonly modifiedAtMs: number;
  readonly displayName: string | undefined;
  readonly archived: boolean;
  readonly metaCorrupt: boolean;
  readonly preview: string | undefined;
  /**
   * True when the journal was deliberately not read: the directory holds more
   * sessions than the preview budget. Additive: readers that never heard of a
   * budget see the same fields as before, plus this one.
   */
  readonly previewOmitted?: true;
  readonly health: SessionHealth;
};

/**
 * How many newest journals get a full read for previews and health. The
 * directory scan stays the fast path for every session; only the journal
 * reads are budgeted, because those are what cost on a big directory.
 * Beyond the budget a row keeps its cheap sidecar facts and says so instead
 * of claiming a health it never measured.
 */
export const SESSION_PREVIEW_BUDGET = 100;

export type SessionListRequest = {
  readonly search?: string;
  readonly all: boolean;
  readonly json: boolean;
};

function previewOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 60);
}

type SessionMeta = {
  readonly id: string;
  readonly bytes: number;
  readonly modifiedAtMs: number;
  readonly displayName: string | undefined;
  readonly archived: boolean;
  readonly metaCorrupt: boolean;
};

function describeOne(dir: string, id: string, bytes: number, modifiedAtMs: number): SessionMeta {
  const base = { id, bytes, modifiedAtMs, displayName: undefined, archived: false, metaCorrupt: false } as const;
  const meta = loadSessionMeta(dir, id);
  if (!meta.ok) {
    return { ...base, metaCorrupt: true };
  }

  return {
    ...base,
    ...(meta.meta.displayName === undefined ? {} : { displayName: meta.meta.displayName }),
    archived: meta.meta.archived === true,
  };
}

export async function enrichOne(dir: string, id: string, bytes: number, modifiedAtMs: number): Promise<EnrichedSession> {
  const named = describeOne(dir, id, bytes, modifiedAtMs);
  const journal = createNdjsonSessionStore({ path: `${dir}/${id}${SESSION_JOURNAL_SUFFIX}` });
  const viewed = await journal.readRecords();
  if (!viewed.ok) {
    const health: SessionHealth = viewed.code === "missing_session" ? "missing" : `unreadable:${viewed.code}`;
    return { ...named, preview: undefined, health };
  }

  if (viewed.view.tornTail) {
    return { ...named, preview: undefined, health: "torn-tail" };
  }

  for (const record of viewed.view.records) {
    if (record.type === "transcript_item" && isTranscriptItem(record.payload) && record.payload.kind === "user") {
      return { ...named, preview: previewOf(record.payload.text), health: "ok" };
    }
  }

  return { ...named, preview: undefined, health: "ok" };
}

export async function enrichSessions(
  ctx: Pick<CliContext, "readDir">,
  dir: string,
  budget: number = SESSION_PREVIEW_BUDGET,
  search?: string,
): Promise<ReadonlyArray<EnrichedSession>> {
  // listSessions is newest-first, so the budget always covers the sessions a
  // person most likely means: --last, the text display, and recent resume.
  const files = listSessions({ readDir: ctx.readDir }, dir);
  const enriched: EnrichedSession[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (file === undefined) {
      continue;
    }

    // Search uses only directory/sidecar facts. Reject unrelated sessions
    // before reading their journals; Desktop recovery has a bounded probe.
    if (search !== undefined && !matchesSearch(describeOne(dir, file.id, file.bytes, file.modifiedAtMs), search)) {
      continue;
    }

    if (index < budget) {
      enriched.push(await enrichOne(dir, file.id, file.bytes, file.modifiedAtMs));
      continue;
    }

    const named = describeOne(dir, file.id, file.bytes, file.modifiedAtMs);

    enriched.push({ ...named, preview: undefined, previewOmitted: true as const, health: "preview-omitted" });
  }

  return enriched;
}

function matchesSearch(session: Pick<SessionMeta, "id" | "displayName">, search: string): boolean {
  const needle = search.toLowerCase();
  return session.id.toLowerCase().includes(needle) ||
    (session.displayName ?? "").toLowerCase().includes(needle);
}

function rowText(session: EnrichedSession, now: number): ReadonlyArray<string> {
  const name = session.displayName ?? "—";
  const health = session.health === "ok"
    ? (session.metaCorrupt ? "[sidecar-corrupt]" : "")
    : `[${session.health}]`;
  const archived = session.archived ? "[archived]" : "";
  const parts = [
    session.id,
    name,
    humanBytes(session.bytes),
    relativeTime(session.modifiedAtMs, now),
    session.preview ?? "—",
    [archived, health].filter(part => part.length > 0).join(" "),
  ];

  return parts;
}

export async function handleSessionList(ctx: CliContext, request: SessionListRequest): Promise<ExitCode> {
  const dir = sessionsDir(ctx.homeDir, ctx.env);
  const enriched = await enrichSessions(ctx, dir, SESSION_PREVIEW_BUDGET, request.search);
  const visible = enriched.filter(session => (request.all || !session.archived) &&
    (request.search === undefined || matchesSearch(session, request.search)));

  if (request.json) {
    ctx.stdout(`${JSON.stringify({
      sessions: visible.map(session => ({
        id: session.id,
        displayName: session.displayName ?? null,
        archived: session.archived,
        bytes: session.bytes,
        modifiedAtMs: session.modifiedAtMs,
        preview: session.preview ?? null,
        previewOmitted: session.previewOmitted === true,
        health: session.health,
        metaCorrupt: session.metaCorrupt,
      })),
    })}\n`);
    return EXIT_CODES.OK;
  }

  if (visible.length === 0) {
    if (request.search !== undefined) {
      ctx.stdout(`no sessions match "${request.search}"\n`);
      ctx.stdout(`run \`trylo session list [--all]\` to see every session\n`);
      return EXIT_CODES.OK;
    }

    ctx.stdout(`no sessions in ${dir}\n`);
    ctx.stdout(`start one with \`trylo run --session <id> "<message>"\`\n`);

    return EXIT_CODES.OK;
  }

  const { shown, hidden } = limited(visible, LIST_LIMIT);
  const now = ctx.now();

  for (const line of aligned(shown.map(session => rowText(session, now)))) {
    ctx.stdout(`${line}\n`);
  }

  if (hidden > 0) {
    ctx.stdout(`... ${hidden} older (--json lists them all)\n`);
  }

  return EXIT_CODES.OK;
}

export type LastSessionOutcome =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly failure: { readonly exitCode: ExitCode; readonly message: string; readonly hint: string } };

/**
 * `run --last` resolution: the newest non-archived session. An unreadable
 * newest journal fails closed (pointing at `session info`) rather than
 * silently continuing an older session the user did not mean.
 */
export async function resolveLastSession(ctx: CliContext): Promise<LastSessionOutcome> {
  const dir = sessionsDir(ctx.homeDir, ctx.env);
  // Lazy newest-first: --last names one session, so reading every journal to
  // find it repeats the cost this budget was built to remove. Stopping at the
  // first non-archived session is behaviour-identical — enrichOne is pure per
  // file and the order never changed.
  const files = listSessions({ readDir: ctx.readDir }, dir);
  let candidate: EnrichedSession | undefined;

  for (const file of files) {
    const enriched = await enrichOne(dir, file.id, file.bytes, file.modifiedAtMs);
    if (!enriched.archived) {
      candidate = enriched;
      break;
    }
  }

  if (candidate === undefined) {
    return {
      ok: false,
      failure: {
        exitCode: EXIT_CODES.CONFIG,
        message: `no sessions in ${dir}`,
        hint: "start one with `trylo run --session <id> \"<message>\"`",
      },
    };
  }

  if (candidate.health !== "ok") {
    return {
      ok: false,
      failure: {
        exitCode: EXIT_CODES.CONFIG,
        message: `newest session ${candidate.id} is ${candidate.health}`,
        hint: `run \`trylo session info ${candidate.id}\` to see what is wrong; archived sessions never win --last`,
      },
    };
  }

  if (!isValidSessionId(candidate.id)) {
    return {
      ok: false,
      failure: {
        exitCode: EXIT_CODES.CONFIG,
        message: `newest session id is not usable: ${candidate.id}`,
        hint: "resume it by explicit id, or remove the stray file",
      },
    };
  }

  return { ok: true, sessionId: candidate.id };
}

export function reportLastFailure(ctx: CliContext, outcome: Extract<LastSessionOutcome, { readonly ok: false }>): ExitCode {
  return reportFailure(ctx, outcome.failure);
}
