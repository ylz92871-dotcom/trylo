import { createCompactionService } from "../../compaction/service.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import {
  loadSessionMeta,
  saveSessionMeta,
  type MigrationRecord,
  type MigrationScope,
} from "../../adapters/session-store/session-meta.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { SESSION_FORMAT_VERSION, type RuntimeFingerprint, type SessionPort } from "../../ports/session.js";
import type { SessionRecord } from "../../ports/session.js";
import type { CompactWindow } from "../../ports/compaction.js";
import type { Transcript } from "../../protocol/transcript.js";
import type { RunCommandOptions } from "./args.js";
import type { CliContext } from "./context.js";
import { fail, type RunFailure } from "./run-failure.js";
import type { ResolvedSettings } from "./run-settings.js";
import { isValidSessionId, sessionPath, sessionsDir } from "./session-paths.js";

/**
 * Opening, resuming, or declining a session.
 *
 * Every path here fails closed: if a stored session cannot be proven intact,
 * or was written under different runtime facts, it is never partially
 * replayed. That is the whole reason this is not inlined into `prepareRun`.
 */

type SessionOpen =
  | { readonly kind: "none" }
  | { readonly kind: "new"; readonly session: SessionPort }
  | {
      readonly kind: "resume";
      readonly session: SessionPort;
      readonly transcript: Transcript;
      /**
       * The window the stored journal projects under. A resume that carried the
       * transcript without it would hand the model the text its own summary
       * replaced — compaction would be write-only.
       */
      readonly window: CompactWindow | undefined;
      /** The journal as loaded: windows already stored sit in here. */
      readonly records: ReadonlyArray<SessionRecord>;
    }
  | { readonly kind: "failed"; readonly failure: RunFailure };

export function fingerprint(
  settings: ResolvedSettings,
  workspaceId: string,
  toolCatalogHash: string,
  workspaceRoot?: string,
): RuntimeFingerprint {
  return {
    schemaVersion: SESSION_FORMAT_VERSION,
    providerId: settings.providerId,
    model: settings.model,
    toolCatalogHash,
    workspaceId,
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
  };
}

/** Which fingerprint drift the caller explicitly accepts on this resume. Absent means none. */
export type ResumeMigration = {
  readonly provider?: boolean;
  readonly model?: boolean;
  readonly catalog?: boolean;
};

/**
 * Fingerprint mismatch changes what an old transcript means, so it fails
 * closed — except for the drift the caller explicitly migrates with
 * `--migrate`. Provider drift requires the caller's explicit destination
 * choice; it never reuses the old credential or rewrites old journal facts.
 * Workspace drift still requires a different session.
 */
function fingerprintMismatch(
  stored: RuntimeFingerprint,
  current: RuntimeFingerprint,
  compatibleCatalogs: ReadonlyArray<string>,
  migrate: ResumeMigration,
): { readonly refused?: string; readonly scopes: ReadonlyArray<MigrationScope> } {
  if (stored.workspaceId !== current.workspaceId) return { refused: "the workspace changed", scopes: [] };

  const scopes: MigrationScope[] = [];

  if (stored.providerId !== current.providerId) {
    if (migrate.provider !== true) return { refused: `provider changed: ${stored.providerId} -> ${current.providerId}`, scopes: [] };
    scopes.push("provider");
  }

  if (stored.model !== current.model) {
    if (migrate.model !== true) {
      return { refused: `model changed: ${stored.model} -> ${current.model}`, scopes: [] };
    }
    scopes.push("model");
  }

  if (stored.toolCatalogHash !== current.toolCatalogHash && !compatibleCatalogs.includes(stored.toolCatalogHash)) {
    if (migrate.catalog !== true) {
      return { refused: "the tool catalog changed", scopes: [] };
    }
    scopes.push("catalog");
  }

  return { scopes };
}

async function openNewSession(
  ctx: CliContext,
  sessionId: string,
  print: RuntimeFingerprint,
): Promise<SessionOpen> {
  const store = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, sessionId) });
  const started = await store.start({
    sessionId,
    createdAt: new Date(ctx.now()).toISOString(),
    fingerprint: print,
  });
  if (started.ok) {
    return { kind: "new", session: store };
  }

  if (started.code === "session_exists") {
    return {
      kind: "failed",
      failure: fail(
        EXIT_CODES.CONFIG,
        `session ${sessionId} already exists`,
        `use --resume ${sessionId} to continue it, or pick another --session id`,
      ),
    };
  }

  return {
    kind: "failed",
    failure: fail(
      EXIT_CODES.CONFIG,
      `cannot start session ${sessionId}: ${started.code}`,
      "another trylo process may hold the session lock; retry once it exits",
    ),
  };
}

/**
 * What to do next when a resume cannot attach, by cause.
 *
 * A missing session means the id is wrong — point at the list, not at a lock
 * file that was never there. Only a real lock conflict earns the stale-lock
 * sentence; anything else gets the generic retry line it always had.
 */
function resumeHint(code: string): string {
  if (code === "missing_session") {
    return "no such session; `trylo session list` shows the resumable ones";
  }

  if (code === "lock_conflict") {
    return "if no other trylo process is running, delete the stale .lock next to the session file";
  }

  return "another trylo process may hold the session lock; retry once it exits";
}

async function openExistingSession(
  ctx: CliContext,
  sessionId: string,
  print: RuntimeFingerprint,
  compatibleCatalogs: ReadonlyArray<string>,
  migrate: ResumeMigration,
): Promise<SessionOpen> {
  const store = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, sessionId) });
  const attached = await store.attach();
  if (!attached.ok) {
    return {
      kind: "failed",
      failure: fail(EXIT_CODES.CONFIG, `cannot resume session ${sessionId}: ${attached.code}`, resumeHint(attached.code)),
    };
  }

  const recovered = await store.read();
  if (!recovered.ok) {
    await store.release();
    return {
      kind: "failed",
      failure: fail(
        EXIT_CODES.CONFIG,
        `session ${sessionId} is not recoverable: ${recovered.code}`,
        "start a new session; a session that cannot be proven intact is never partially replayed",
      ),
    };
  }

  if (recovered.session.repairedTornTail) {
    const repaired = await store.repairTornTail();
    if (!repaired.ok) {
      await store.release();
      return {
        kind: "failed",
        failure: fail(
          EXIT_CODES.CONFIG,
          `session ${sessionId} has a torn tail that could not be repaired: ${repaired.code}`,
          "inspect the session file; only an unterminated last line may be dropped",
        ),
      };
    }
  }

  const mismatch = fingerprintMismatch(recovered.session.fingerprint, print, compatibleCatalogs, migrate);
  if (mismatch.refused !== undefined) {
    await store.release();
    return {
      kind: "failed",
      failure: fail(
        EXIT_CODES.CONFIG,
        `session ${sessionId} cannot be continued: ${mismatch.refused}`,
        "start a new session instead; resuming would reinterpret the stored transcript",
      ),
    };
  }

  if (mismatch.scopes.length > 0) {
    const logged = recordMigration(ctx, sessionId, recovered.session.fingerprint, print, mismatch.scopes);
    if (!logged) {
      await store.release();
      return {
        kind: "failed",
        failure: fail(
          EXIT_CODES.CONFIG,
          `session ${sessionId} migration cannot be recorded: the sidecar is not writable`,
          "the journal is untouched; fix the sidecar, then resume with --migrate again",
        ),
      };
    }
  }

  const records = await store.readRecords();
  if (!records.ok) {
    await store.release();
    return { kind: "failed", failure: fail(EXIT_CODES.CONFIG,
      `session ${sessionId} records cannot be read: ${records.code}`, "start a new session; unreadable records are never treated as empty history") };
  }

  if (recovered.session.reconcileRequired.length > 0) {
    await store.release();
    return { kind: "failed", failure: fail(EXIT_CODES.CONFIG,
      `session ${sessionId} requires effect reconciliation: ${recovered.session.reconcileRequired.join(", ")}`,
      "inspect the journal, workspace and running processes before starting a new session; unknown actions are never automatically repeated") };
  }

  const stored = records.view.records;
  const projected = createCompactionService().projectForPrompt({ records: stored });
  if (!projected.ok) {
    await store.release();
    return { kind: "failed", failure: fail(EXIT_CODES.CONFIG,
      `session ${sessionId} prompt history cannot be projected: ${projected.code}`, "repair the stored compact boundary or start a new session") };
  }

  return {
    kind: "resume",
    session: store,
    transcript: recovered.session.transcript,
    window: projected.view.window,
    records: stored,
  };
}

/**
 * Records an accepted migration in the session sidecar. The journal itself is
 * append-only and keeps the old facts; this log says who accepted what drift
 * and when, so a later reader can tell a migrated resume from an original one.
 * A sidecar that cannot be read or written refuses the migrated resume — the
 * migration fact going missing silently would be worse than not migrating.
 */
function recordMigration(
  ctx: CliContext,
  sessionId: string,
  from: RuntimeFingerprint,
  to: RuntimeFingerprint,
  scopes: ReadonlyArray<MigrationScope>,
): boolean {
  const dir = sessionsDir(ctx.homeDir, ctx.env);
  const loaded = loadSessionMeta(dir, sessionId);
  if (!loaded.ok) {
    return false;
  }

  const entry: MigrationRecord = {
    at: new Date(ctx.now()).toISOString(),
    from,
    to,
    scope: scopes,
  };
  const previous = loaded.meta.migrations ?? [];

  return saveSessionMeta(dir, sessionId, { ...loaded.meta, migrations: [...previous, entry] });
}

function invalidSessionId(value: string): SessionOpen {
  return {
    kind: "failed",
    failure: fail(
      EXIT_CODES.USAGE,
      `invalid session id: ${value}`,
      "use letters, digits, dot, dash and underscore, at most 128 characters",
    ),
  };
}

export async function openSession(
  ctx: CliContext,
  options: RunCommandOptions,
  print: RuntimeFingerprint,
  compatibleCatalogs: ReadonlyArray<string> = [],
): Promise<SessionOpen> {
  const migrate: ResumeMigration = {
    ...(options.migrateProvider === true ? { provider: true } : {}),
    ...(options.migrateModel === true ? { model: true } : {}),
    ...(options.migrateCatalog === true ? { catalog: true } : {}),
  };

  if (options.session !== undefined) {
    if (!isValidSessionId(options.session)) {
      return invalidSessionId(options.session);
    }
    return openNewSession(ctx, options.session, print);
  }

  if (options.resume !== undefined) {
    if (!isValidSessionId(options.resume)) {
      return invalidSessionId(options.resume);
    }
    return openExistingSession(ctx, options.resume, print, compatibleCatalogs, migrate);
  }

  return { kind: "none" };
}
