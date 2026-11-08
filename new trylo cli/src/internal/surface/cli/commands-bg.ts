import type { CliContext } from "./context.js";
import { isSessionId } from "../../ports/background-session.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { handlePs } from "./bg-ps.js";
import { handleLogs } from "./bg-logs.js";
import { handleAttach } from "./bg-attach.js";
import { handleKill } from "./bg-kill.js";
import type { BackgroundDeps } from "./bg-shared.js";

/**
 * `trylo bg` entry point (WP26 / A04) — the old `claude ps|logs|attach|kill`.
 *
 * This file owns only parsing, dispatch and help. Each verb's answer lives in
 * its own module (`bg-ps.ts`, `bg-logs.ts`, `bg-attach.ts`, `bg-kill.ts`);
 * what every verb needs the same way lives in `bg-shared.ts`.
 */

export type { BackgroundDeps, JobLiveness } from "./bg-shared.js";

export type BackgroundVerb =
  | { readonly verb: "ps"; readonly sessionId: string | undefined; readonly json: boolean }
  | { readonly verb: "logs"; readonly sessionId: string | undefined; readonly follow: boolean; readonly json: boolean }
  | { readonly verb: "attach"; readonly sessionId: string; readonly json: boolean }
  | { readonly verb: "kill"; readonly sessionId: string; readonly json: boolean };

export type BackgroundParse = BackgroundVerb | { readonly verb: "help" } | { readonly verb: "error"; readonly message: string; readonly hint: string };

export function parseBackground(argv: ReadonlyArray<string>): BackgroundParse {
  const [verb, ...rest] = argv;

  if (verb === undefined || verb === "--help" || verb === "-h" || verb === "help") {
    return { verb: "help" };
  }

  const positional = rest.filter((token) => !token.startsWith("--"));
  const sessionId = positional[0];
  const json = rest.some((token) => token === "--json");

  if (verb === "ps" || verb === "list") {
    return parsePsArg(sessionId, json);
  }

  if (verb === "logs") {
    return parseLogsArg(sessionId, rest, json);
  }

  if (verb === "attach") {
    return parseAttachArg(sessionId, json);
  }

  if (verb === "kill" || verb === "stop") {
    return parseKillArg(sessionId, json);
  }

  return { verb: "error", message: `unknown subcommand 'bg ${verb}'`, hint: "expected ps, logs, attach or kill" };
}

export async function handleBackground(
  ctx: CliContext,
  parsed: BackgroundParse,
  deps: BackgroundDeps,
): Promise<ExitCode> {
  if (parsed.verb === "help") {
    ctx.stdout(backgroundHelp());
    return EXIT_CODES.OK;
  }

  if (parsed.verb === "error") {
    ctx.stderr(`${parsed.message}\n${parsed.hint}\n`);
    return EXIT_CODES.USAGE;
  }

  if (parsed.verb === "ps") {
    return handlePs(ctx, parsed.sessionId, parsed.json, deps);
  }

  if (parsed.verb === "logs") {
    return handleLogs(ctx, parsed, deps);
  }

  if (parsed.verb === "attach") {
    return handleAttach(ctx, parsed.sessionId, parsed.json, deps);
  }

  return handleKill(ctx, parsed.sessionId, parsed.json, deps);
}

function parsePsArg(sessionId: string | undefined, json: boolean): BackgroundParse {
  // A malformed id is refused here rather than at the lookup, so the message is
  // about the argument rather than about a session that happens not to exist.
  if (sessionId !== undefined && !isSessionId(sessionId)) {
    return refuseBadId(
      sessionId,
      "run `trylo bg ps` to see the ids in use; they look like ps_ followed by 24 hex characters",
    );
  }
  return { verb: "ps", sessionId, json };
}

function parseLogsArg(sessionId: string | undefined, rest: ReadonlyArray<string>, json: boolean): BackgroundParse {
  if (sessionId === undefined) {
    return { verb: "logs", sessionId: undefined, follow: false, json };
  }

  if (!isSessionId(sessionId)) {
    return refuseBadId(sessionId, "run `trylo bg ps` to see the ids in use");
  }

  return { verb: "logs", sessionId, follow: rest.includes("--follow") || rest.includes("-f"), json };
}

function parseAttachArg(sessionId: string | undefined, json: boolean): BackgroundParse {
  if (sessionId === undefined) {
    return { verb: "error", message: "attach needs a session id", hint: "trylo bg attach <sessionId>" };
  }

  if (!isSessionId(sessionId)) {
    return refuseBadId(sessionId, "run `trylo bg ps` to see the ids in use");
  }

  return { verb: "attach", sessionId, json };
}

function parseKillArg(sessionId: string | undefined, json: boolean): BackgroundParse {
  if (sessionId === undefined) {
    return { verb: "error", message: "kill needs a session id", hint: "trylo bg kill <sessionId>" };
  }

  if (!isSessionId(sessionId)) {
    return refuseBadId(sessionId, "run `trylo bg ps` to see the ids in use");
  }

  return { verb: "kill", sessionId, json };
}

function refuseBadId(sessionId: string, hint: string): BackgroundParse {
  return { verb: "error", message: `'${sessionId}' is not a session id`, hint };
}

function backgroundHelp(): string {
  return [
    "trylo bg — background jobs started on this machine",
    "",
    "  bg ps [sessionId]        what is running, and how the finished ones ended",
    "  bg logs <id> [--follow]  its output, from the log file the owner keeps writing",
    "  bg attach <id>           watch its output only (no stdin, no resize, no owner transfer)",
    "  bg kill <id>             stop it and everything it started",
    "",
    "To type into a job, use the terminal that started it — `attach` only watches.",
    "",
    "Ids look like ps_ followed by 24 hex characters; `bg ps` lists them.",
    "",
    "These are durable records, so they answer across processes: a job started by",
    "one `trylo run` is visible to this command in another terminal. A record whose",
    "process cannot be found is reported as `lost`, never as a guessed exit code.",
    "",
    "Durations read as 0.4s / 12s / 3m04s / 2h11m.",
    "",
  ].join("\n");
}
