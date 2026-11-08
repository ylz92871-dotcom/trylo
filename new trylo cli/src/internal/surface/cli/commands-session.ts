import {
  deleteSessionFiles,
  loadSessionMeta,
  normalizeDisplayName,
  saveSessionMeta,
  type SessionMeta,
} from "../../adapters/session-store/session-meta.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { transferChatContinuationForFork } from "../../adapters/provider/chat-continuation-fork.js";
import type { ProviderContinuationForkTransfer } from "../../ports/provider.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { RuntimeFingerprint } from "../../ports/session.js";
import type { Transcript } from "../../protocol/transcript.js";
import type { SessionTargetOptions } from "./args-session.js";
import type {
  SessionArchiveOptions,
  SessionExportOptions,
  SessionForkOptions,
  SessionRenameOptions,
} from "./args-session.js";
import type { CliContext } from "./context.js";
import { reportFailure } from "./run-failure.js";
import { planFork } from "./session-fork.js";
import { isValidSessionId, sessionsDir, sessionPath } from "./session-paths.js";

/**
 * WP02 session verbs beyond `list`: inspect, branch, name, export, park and
 * delete sessions.
 *
 * Every verb is read- or write-through the Session management service's own
 * files (the journal via its store, the sidecar via `session-meta.ts`). No
 * verb here takes the session writer lock except `fork`, which must: it
 * starts the child session it creates. Nothing here reinterprets the journal
 * — failures name the file and the code, and the journal is left as found.
 */

function invalidId(ctx: CliContext, id: string): ExitCode {
  return reportFailure(ctx, {
    exitCode: EXIT_CODES.USAGE,
    message: `invalid session id: ${id}`,
    hint: "use letters, digits, dot, dash and underscore, at most 128 characters",
  });
}

function missingSession(ctx: CliContext, id: string): ExitCode {
  return reportFailure(ctx, {
    exitCode: EXIT_CODES.CONFIG,
    message: `no such session: ${id}`,
    hint: "`trylo session list` shows the resumable ones",
  });
}

function unreadableSession(ctx: CliContext, id: string, code: string): ExitCode {
  return reportFailure(ctx, {
    exitCode: EXIT_CODES.CONFIG,
    message: `session ${id} is not readable: ${code}`,
    hint: `run \`trylo session info ${id}\` for the detail; a session that cannot be proven intact is never partially shown`,
  });
}

function corruptSidecar(ctx: CliContext, dir: string, id: string): ExitCode {
  return reportFailure(ctx, {
    exitCode: EXIT_CODES.CONFIG,
    message: `session ${id} has a corrupt sidecar`,
    hint: `remove ${dir}/${id}.meta.json to regenerate it; the journal is untouched`,
  });
}

export async function handleSessionInfo(ctx: CliContext, options: SessionTargetOptions): Promise<ExitCode> {
  if (!isValidSessionId(options.session)) {
    return invalidId(ctx, options.session);
  }

  const dir = sessionsDir(ctx.homeDir, ctx.env);
  const store = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, options.session) });
  const read = await store.read();
  if (!read.ok) {
    if (read.code === "missing_session") {
      return missingSession(ctx, options.session);
    }
    return unreadableSession(ctx, options.session, read.code);
  }

  const meta = loadSessionMeta(dir, options.session);
  if (!meta.ok) {
    return corruptSidecar(ctx, dir, options.session);
  }

  const session = read.session;
  const userMessages = session.transcript.filter(item => item.kind === "user").length;
  const view = {
    id: options.session,
    displayName: meta.meta.displayName ?? null,
    archived: meta.meta.archived === true,
    provider: session.fingerprint.providerId,
    model: session.fingerprint.model,
    workspace: session.fingerprint.workspaceId,
    toolCatalog: session.fingerprint.toolCatalogHash,
    records: session.lastSequence + 1,
    messages: session.transcript.length,
    userMessages,
    tornTail: session.repairedTornTail,
    reconcileRequired: session.reconcileRequired,
    forkedFrom: meta.meta.forkedFrom ?? null,
    migrations: meta.meta.migrations ?? [],
  };

  if (options.json) {
    ctx.stdout(`${JSON.stringify(view)}\n`);
    return EXIT_CODES.OK;
  }

  const status = session.reconcileRequired.length > 0
    ? `${session.reconcileRequired.length} action(s) need reconcile: ${session.reconcileRequired.join(", ")}`
    : session.repairedTornTail ? "torn tail repaired" : "clean";

  ctx.stdout(`session   ${view.id}\n`);
  ctx.stdout(`name      ${view.displayName ?? "—"}\n`);
  ctx.stdout(`archived  ${view.archived ? "yes" : "no"}\n`);
  ctx.stdout(`provider  ${view.provider}\n`);
  ctx.stdout(`model     ${view.model}\n`);
  ctx.stdout(`workspace ${view.workspace}\n`);
  ctx.stdout(`catalog   ${view.toolCatalog}\n`);
  ctx.stdout(`records   ${view.records}\n`);
  ctx.stdout(`messages  ${view.messages} (${view.userMessages} user)\n`);
  ctx.stdout(`status    ${status}\n`);
  ctx.stdout(`forked    ${view.forkedFrom === null ? "—" : `from ${view.forkedFrom.parentSessionId} @${view.forkedFrom.parentLastSequence} (${view.forkedFrom.snapshot})`}\n`);
  ctx.stdout(`migrated  ${view.migrations.length === 0 ? "—" : `${view.migrations.length} time(s), last ${view.migrations[view.migrations.length - 1]?.at ?? ""}`}\n`);

  return EXIT_CODES.OK;
}

export async function handleSessionFork(
  ctx: CliContext,
  options: SessionForkOptions,
  transferContinuation: ProviderContinuationForkTransfer = transferChatContinuationForFork,
): Promise<ExitCode> {
  if (!isValidSessionId(options.session)) {
    return invalidId(ctx, options.session);
  }

  const childId = options.newId ?? ctx.newId("session");
  if (!isValidSessionId(childId)) {
    return invalidId(ctx, childId);
  }

  const dir = sessionsDir(ctx.homeDir, ctx.env);
  const parentPath = sessionPath(ctx.homeDir, ctx.env, options.session);
  const parent = createNdjsonSessionStore({ path: parentPath });
  const viewed = await parent.readRecords();
  if (!viewed.ok) {
    if (viewed.code === "missing_session") {
      return missingSession(ctx, options.session);
    }
    return unreadableSession(ctx, options.session, viewed.code);
  }

  const read = await parent.read();
  if (!read.ok) {
    if (read.code === "missing_session") {
      return missingSession(ctx, options.session);
    }
    return unreadableSession(ctx, options.session, read.code);
  }

  if (options.newId !== undefined) {
    const clash = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, options.newId) });
    const clashView = await clash.readRecords();
    if (clashView.ok || (clashView.ok === false && clashView.code !== "missing_session")) {
      return reportFailure(ctx, {
        exitCode: EXIT_CODES.CONFIG,
        message: `session ${options.newId} already exists`,
        hint: "pick another --new-id, or omit it for a generated one",
      });
    }
  }

  const planned = planFork({
    records: viewed.view.records,
    tornTail: viewed.view.tornTail,
    snapshot: options.beforeUserMessage !== undefined
      ? { mode: "before-user-message", n: options.beforeUserMessage }
      : options.interrupted ? { mode: "interrupted" } : { mode: "settled-prefix" },
    parentSessionId: options.session,
    childSessionId: childId,
    at: new Date(ctx.now()).toISOString(),
  });
  if (!planned.ok) {
    return reportFailure(ctx, {
      exitCode: EXIT_CODES.CONFIG,
      message: `cannot fork session ${options.session}: ${planned.detail}`,
      hint: planned.code === "unsettled_effects"
        ? "the parent has unfinished work; `session reconcile` it first, or fork with --interrupted to leave it behind"
        : "`trylo session info` shows the parent as it stands",
    });
  }

  const transferred = transferContinuation({ parentSessionId: options.session, childSessionId: childId, records: planned.records });
  const child = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, childId) });
  const started = await child.start({
    sessionId: childId,
    createdAt: new Date(ctx.now()).toISOString(),
    fingerprint: read.session.fingerprint,
  });
  if (!started.ok) {
    return reportFailure(ctx, {
      exitCode: EXIT_CODES.CONFIG,
      message: `cannot start fork ${childId}: ${started.code}`,
      hint: "another trylo process may hold the session lock; retry once it exits",
    });
  }

  for (const record of transferred.records) {
    const appended = await child.append(record);
    if (!appended.ok) {
      await child.release();
      return reportFailure(ctx, {
        exitCode: EXIT_CODES.CONFIG,
        message: `fork ${childId} stopped mid-write: ${appended.code}`,
        hint: `the child journal keeps its resumable prefix; resume it with --resume ${childId} or remove it with \`session remove ${childId}\``,
      });
    }
  }

  await child.release();
  const meta: SessionMeta = { version: 1, forkedFrom: planned.provenance };
  if (!saveSessionMeta(dir, childId, meta)) {
    return reportFailure(ctx, {
      exitCode: EXIT_CODES.CONFIG,
      message: `forked ${options.session} -> ${childId}, but the provenance sidecar cannot be written`,
      hint: `the child journal is resumable; record the provenance with the fork detail above`,
    });
  }

  const dropped = planned.provenance.droppedPending + planned.provenance.droppedPartials;
  const nativeContinuation = transferred.report.reboundCheckpoints > 0 || transferred.report.unavailable.length > 0
    ? transferred.report : undefined;

  if (options.json) {
    ctx.stdout(`${JSON.stringify({
      parent: options.session,
      child: childId,
      copiedRecords: planned.provenance.copiedRecords,
      snapshot: planned.provenance.snapshot,
      droppedPending: planned.provenance.droppedPending,
      droppedPartials: planned.provenance.droppedPartials,
      ...(nativeContinuation === undefined ? {} : { nativeContinuation }),
    })}\n`);
    return EXIT_CODES.OK;
  }

  ctx.stdout(`forked ${options.session} -> ${childId} (${planned.provenance.copiedRecords} records, ${planned.provenance.snapshot})\n`);

  if (dropped > 0) {
    ctx.stdout(`left behind: ${planned.provenance.droppedPending} unsettled effect(s), ${planned.provenance.droppedPartials} partial block(s)\n`);
  }

  if (nativeContinuation !== undefined) {
    const unavailable = nativeContinuation.unavailable.map(item => `${item.cause}=${item.checkpoints}`).join(", ");
    ctx.stdout(`native checkpoints: ${nativeContinuation.reboundCheckpoints} rebound (${nativeContinuation.nativeCheckpoints} with original native material); unavailable: ${unavailable || "none"}; target connection is checked on resume\n`);
  }

  ctx.stdout(`resume it with \`trylo run --resume ${childId} "<message>"\`\n`);

  return EXIT_CODES.OK;
}

export async function handleSessionRename(ctx: CliContext, options: SessionRenameOptions): Promise<ExitCode> {
  if (!isValidSessionId(options.session)) {
    return invalidId(ctx, options.session);
  }

  const normalized = normalizeDisplayName(options.name);
  if (normalized === undefined) {
    return reportFailure(ctx, {
      exitCode: EXIT_CODES.USAGE,
      message: "session rename requires a non-empty name",
      hint: "try `trylo session rename <id> <new name>`",
    });
  }

  const dir = sessionsDir(ctx.homeDir, ctx.env);
  const store = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, options.session) });
  const viewed = await store.readRecords();
  if (!viewed.ok && viewed.code === "missing_session") {
    return missingSession(ctx, options.session);
  }

  const meta = loadSessionMeta(dir, options.session);
  if (!meta.ok) {
    return corruptSidecar(ctx, dir, options.session);
  }

  if (!saveSessionMeta(dir, options.session, { ...meta.meta, displayName: normalized })) {
    return reportFailure(ctx, {
      exitCode: EXIT_CODES.CONFIG,
      message: `cannot rename session ${options.session}: the sidecar cannot be written`,
      hint: `check ${dir} is writable`,
    });
  }

  ctx.stdout(`renamed ${options.session} to "${normalized}"\n`);

  return EXIT_CODES.OK;
}

export async function handleSessionExport(ctx: CliContext, options: SessionExportOptions): Promise<ExitCode> {
  if (!isValidSessionId(options.session)) {
    return invalidId(ctx, options.session);
  }

  const dir = sessionsDir(ctx.homeDir, ctx.env);
  const store = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, options.session) });
  const read = await store.read();
  if (!read.ok) {
    if (read.code === "missing_session") {
      return missingSession(ctx, options.session);
    }
    return unreadableSession(ctx, options.session, read.code);
  }

  const meta = loadSessionMeta(dir, options.session);
  if (!meta.ok) {
    return corruptSidecar(ctx, dir, options.session);
  }

  const session = read.session;

  if (options.format === "json") {
    ctx.stdout(`${JSON.stringify({
      version: 1,
      session: options.session,
      displayName: meta.meta.displayName ?? null,
      archived: meta.meta.archived === true,
      fingerprint: session.fingerprint,
      forkedFrom: meta.meta.forkedFrom ?? null,
      migrations: meta.meta.migrations ?? [],
      transcript: session.transcript,
    })}\n`);
    return EXIT_CODES.OK;
  }

  ctx.stdout(renderSessionMarkdown(options.session, session.fingerprint, session.transcript));

  return EXIT_CODES.OK;
}

function renderSessionMarkdown(
  id: string,
  fingerprint: RuntimeFingerprint,
  transcript: Transcript,
): string {
  const lines = [
    `# Session ${id}`,
    "",
    `- provider: ${fingerprint.providerId}`,
    `- model: ${fingerprint.model}`,
    `- workspace: ${fingerprint.workspaceId}`,
    "",
    "## transcript",
    "",
  ];

  for (const item of transcript) {
    if (item.kind === "user") {
      lines.push("### user", "", item.text, "");
    } else if (item.kind === "assistant_text") {
      lines.push("### assistant", "", item.text, "");
    } else if (item.kind === "assistant_reasoning") {
      lines.push("### reasoning", "", item.text, "");
    } else if (item.kind === "system") {
      lines.push("### system", "", item.text, "");
    } else if (item.kind === "tool_call") {
      lines.push(`### tool_call ${item.name} (${item.toolCallId})`, "", "```json", JSON.stringify(item.arguments), "```", "");
    } else if (item.kind === "tool_result") {
      lines.push(`### tool_result ${item.name} (${item.toolCallId}) [${item.outcome}]`, "", item.output, "");
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function handleSessionArchive(ctx: CliContext, options: SessionArchiveOptions): Promise<ExitCode> {
  if (!isValidSessionId(options.session)) {
    return invalidId(ctx, options.session);
  }

  const dir = sessionsDir(ctx.homeDir, ctx.env);
  const store = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, options.session) });
  const viewed = await store.readRecords();
  if (!viewed.ok && viewed.code === "missing_session") {
    return missingSession(ctx, options.session);
  }

  const meta = loadSessionMeta(dir, options.session);
  if (!meta.ok) {
    return corruptSidecar(ctx, dir, options.session);
  }

  if (!saveSessionMeta(dir, options.session, { ...meta.meta, archived: options.archived })) {
    return reportFailure(ctx, {
      exitCode: EXIT_CODES.CONFIG,
      message: `cannot ${options.archived ? "archive" : "unarchive"} session ${options.session}: the sidecar cannot be written`,
      hint: `check ${dir} is writable`,
    });
  }

  ctx.stdout(`${options.archived ? "archived" : "unarchived"} ${options.session}\n`);

  return EXIT_CODES.OK;
}

export function handleSessionRemove(ctx: CliContext, options: SessionTargetOptions): ExitCode {
  if (!isValidSessionId(options.session)) {
    return invalidId(ctx, options.session);
  }

  const deleted = deleteSessionFiles(sessionPath(ctx.homeDir, ctx.env, options.session));
  if (!deleted.ok) {
    if (deleted.code === "missing_session") {
      return missingSession(ctx, options.session);
    }
    return reportFailure(ctx, {
      exitCode: EXIT_CODES.CONFIG,
      message: `cannot remove session ${options.session}: ${deleted.detail}`,
      hint: deleted.code === "lock_conflict"
        ? "a live writer holds this session; retry once it exits"
        : "the session files could not be removed; nothing was renamed or rewritten",
    });
  }

  ctx.stdout(`removed ${options.session} (journal${deleted.removedMeta ? " and sidecar" : ""})\n`);

  return EXIT_CODES.OK;
}
