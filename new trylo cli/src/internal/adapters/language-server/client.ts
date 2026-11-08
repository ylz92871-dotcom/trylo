/**
 * The one module allowed to know a language server exists as a process.
 *
 * Everything upstream — the tools, the loop, the journal — speaks the
 * `LanguageServerPort` contract in `ports/language-server.ts`. This file and its
 * siblings are the only place `vscode-*` types appear, and they convert at the
 * boundary. That containment is not tidiness: it is what makes the transport
 * replaceable and a stored result stable when the protocol package changes.
 *
 * Reused from the legacy CLI's `services/lsp/` (LSPClient / LSPServerInstance /
 * LSPServerManager, ~2 400 lines). What was kept is the mechanical shape —
 * spawn, stdio framing, initialize handshake, capability bookkeeping, shutdown.
 * What was dropped is everything that made it a second runtime: the legacy global
 * config singleton, its logger, its own permission path, and its restart policy.
 * Those are now the caller's to inject, because permission has exactly one owner
 * in Trylo and a language server that quietly started itself would be a second.
 *
 * Two facts about the current dependency versions shape this file, both found by
 * probe rather than by reading the legacy source:
 *   - the entry is `vscode-jsonrpc/node`, not `vscode-jsonrpc/node.js`; 9.x
 *     dropped the `.js` subpath from its exports map;
 *   - `connection.listen()` must happen before any request, or the first
 *     `sendRequest` throws `Call listen() first.`
 */

import { spawn, type ChildProcess } from "child_process";
import { createMessageConnection, type MessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import type {
  LanguageServerPort,
  LspDocument,
  LspFailure,
  LspLimits,
  LspLocation,
  LspQuery,
  LspQueryResult,
  LspServerCapabilities,
  LspServerSpec,
} from "../../ports/language-server.js";
import { DEFAULT_LSP_LIMITS } from "../../ports/language-server.js";
import { createBoundedStdout, isLimitError } from "./lsp-limits.js";
import { mapLspError, type RequestSender } from "./lsp-request.js";
import { runOperation, serverSupports, toCancellationToken } from "./lsp-operations.js";
import { toCapabilities } from "./lsp-capabilities.js";
import { pathToUri, uriToPath } from "./lsp-uri.js";
import { withDeadline } from "./lsp-deadline.js";
import { ConnectionSlots } from "./lsp-slots.js";
import { DocumentSynchroniser } from "./lsp-documents.js";
import { handshake, preload, sendNotification, type LspPreloadDocument } from "./lsp-handshake.js";
import { describe } from "./lsp-failure-text.js";

/**
 * Dependencies injected so this module has no hidden owner of its own.
 *
 * `hostEnv` is here because of the gate, and the gate is right: `process.env` in
 * this file would be a second, invisible source of the environment, and the
 * ambient scan exists to stop exactly that. The caller passes the environment it
 * already holds, which also makes "what does a language server inherit?"
 * answerable instead of assumed.
 */
export type LspProcessDeps = {
  /** Ask the permission layer whether a program may be started. */
  authorize(command: string, args: ReadonlyArray<string>): Promise<LspFailure | { readonly ok: true }>;
  /**
   * The environment a language server inherits, before `spec.env` is layered on
   * top. Required rather than defaulted to `process.env`: a default would put
   * the ambient read back, only one indirection away.
   */
  hostEnv: Readonly<Record<string, string | undefined>>;
  /** Surface for structured logs. No console, no legacy logger. */
  log(event: LspLogEvent): void;
};

export type LspLogEvent = {
  readonly serverName: string;
  readonly phase: "starting" | "initialized" | "ready" | "exited" | "closed" | "refused" | "timeout";
  readonly detail?: string;
};

export type CreateLanguageServerOptions = {
  readonly spec: LspServerSpec;
  readonly limits?: LspLimits;
  readonly deps: LspProcessDeps;
  /**
   * Open documents handed over on `textDocument/didOpen` before the first query.
   * A server cannot resolve a position in a file it was never told about, which
   * is the usual cause of an "answered, but empty" hover.
   */
  readonly preloadDocuments?: ReadonlyArray<LspPreloadDocument>;
  /**
   * How long `close()` and idle expiry wait for a server to leave on its own
   * after `shutdown`/`exit` before killing it. A server that ignores the exit
   * notification must not become a zombie: the process belongs to this
   * connection, and the connection is ending either way.
   */
  readonly stopGraceMs?: number;
};

export type { LspPreloadDocument };

/**
 * Lifecycle, stated once. Every transition lists what it may assume, because
 * the failure this file exists to prevent is a request answered against a server
 * that has already gone away.
 *
 *   stopped --start--> starting --> ready --> closing --> stopped
 *      ^                   |          |           |
 *      +------- failed <---+          +-----------+   (exited, any crash)
 */
export type LspConnectionState = "stopped" | "starting" | "ready" | "closing";

export function createLanguageServer(options: CreateLanguageServerOptions): LanguageServerPort {
  const limits = options.limits ?? DEFAULT_LSP_LIMITS;
  const { spec } = options;
  // Guards concurrency and shutdown races. One mutable owner, not scattered booleans.
  const slots = new ConnectionSlots();

  let state: LspConnectionState = "stopped";
  let connection: MessageConnection | undefined;
  let child: ChildProcess | undefined;
  let capabilities: LspServerCapabilities | undefined;
  let startPromise: Promise<LspFailure | { ok: true }> | undefined;
  let intentionalStop = false;
  const stopGraceMs = options.stopGraceMs ?? 2000;
  // Owns the didOpen/didChange choice and the version history behind it.
  const documents = new DocumentSynchroniser(spec.workspaceRoot);

  function fail(code: LspFailure["code"], message: string): LspFailure {
    return { ok: false, code, message };
  }

  /** Every pending request is settled before this returns; nothing outlives it. */
  function teardown(detail: string): void {
    const openConnection = connection;
    const proc = child;

    connection = undefined;
    child = undefined;
    capabilities = undefined;
    // A new connection has never seen these documents, so their versions must
    // not be replayed against it.
    documents.reset();
    state = "stopped";

    // The process belongs to this connection. A server that already exited
    // makes the kill a guarded no-op; one that did not is reaped rather than
    // orphaned as a zombie holding the workspace it was indexing.
    if (proc !== undefined && proc.exitCode === null) {
      try {
        proc.kill();
      } catch {
        // Gone between the check and the signal; nothing left to reap.
      }
    }

    // Settle first: a pending request must never hang past the process. The
    // slots layer speaks `Error` because that is what a promise rejects with;
    // `mapLspError` turns this one back into the typed `lsp_server_exited`
    // failure at the query boundary, so no caller sees a raw Error.
    const exited = new Error(`language server exited: ${detail}`);

    exited.name = "LspServerExited";
    slots.settleAllPending(exited);

    if (openConnection) {
      try {
        openConnection.dispose();
      } catch (error) {
        // Disposal is best-effort teardown of an already-broken pipe. The
        // pending requests are already settled above, so there is nothing left
        // to salvage and rethrowing would only mask the exit that caused this.
        options.deps.log({ serverName: spec.serverName, phase: "closed", detail: describe(error) });
      }
    }
  }

  async function start(): Promise<LspFailure | { ok: true }> {
    if (state === "ready") {
      return { ok: true };
    }

    if (startPromise) {
      return startPromise;
    }

    startPromise = (async () => {
      state = "starting";
      const permitted = await options.deps.authorize(spec.command, spec.args);
      if (!permitted.ok) {
        state = "stopped";
        options.deps.log({ serverName: spec.serverName, phase: "refused", detail: permitted.code });
        startPromise = undefined;
        return permitted;
      }

      try {
        return await launch();
      } finally {
        startPromise = undefined;
      }
    })();

    return startPromise;
  }

  async function launch(): Promise<LspFailure | { ok: true }> {
    options.deps.log({ serverName: spec.serverName, phase: "starting", detail: spec.command });
    const spawned = spawn(spec.command, [...spec.args], {
      cwd: spec.workspaceRoot,
      // The server inherits the host environment plus whatever its own config
      // adds. A server that found no PATH would fail with ENOENT and blame the
      // user's installation, so the base layer is not optional.
      env: { ...options.deps.hostEnv, ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
      // A language server must never inherit a TTY and then sit on it.
      windowsHide: true,
    });

    child = spawned;

    spawned.on("error", (error) => {
      if (intentionalStop) {
        return;
      }
      teardown(describe(error));
    });
    spawned.on("exit", (code, signal) => {
      if (intentionalStop) {
        return;
      }
      teardown(`exit=${String(code)} signal=${String(signal)}`);
      options.deps.log({ serverName: spec.serverName, phase: "exited", detail: `code=${String(code)}` });
    });
    // stderr of a language server is diagnostic output, not a protocol channel.
    // Draining it is required: an unread pipe fills and blocks the server.
    spawned.stderr?.resume();

    if (spawned.stdout === null || spawned.stdin === null) {
      teardown("no stdio pipes");
      return fail("lsp_unsupported_transport", `language server ${spec.serverName} exposed no stdio pipes`);
    }

    // Bounded before framed: a message that declares more than the cap is
    // refused before its body is allocated, not after the reader parsed it.
    const open = createMessageConnection(
      new StreamMessageReader(createBoundedStdout(spawned.stdout, limits.maxMessageBytes)),
      new StreamMessageWriter(spawned.stdin),
    );

    connection = open;

    // Registering crash handling before listen(): a server that dies during
    // initialize must still settle whatever we have already asked of it.
    // A size refusal settles pending callers as over-limit first: teardown's
    // own exit settlement then finds nothing left and stays silent.
    open.onError((event) => {
      const error = event[0];
      if (isLimitError(error)) {
        slots.settleAllPending(error);
      }
      teardown("connection error");
    });
    open.onClose(() => {
      if (!intentionalStop && state !== "stopped") {
        teardown("connection closed");
      }
    });
    // 9.x requires listen() before any request; see the header note.
    open.listen();

    const initialize = await handshake(open, spec, limits.requestTimeoutMs, (detail) => teardown(detail));
    if (!initialize.ok) {
      teardown("initialize failed");
      return initialize;
    }

    capabilities = toCapabilities(initialize.value.capabilities);
    state = "ready";
    await sendNotification(open, "initialized", {});
    await preload(open, documents, options.preloadDocuments ?? [], (detail) =>
      options.deps.log({ serverName: spec.serverName, phase: "initialized", detail }),
    );
    options.deps.log({ serverName: spec.serverName, phase: "initialized" });

    return { ok: true };
  }

  /**
   * Ask a running server to leave, then reap it: notifications first for a
   * clean exit, a grace-bounded kill for one that ignores them. `close()` and
   * idle expiry share this path so a connection ends on purpose exactly once.
   */
  async function stopServer(reason: string): Promise<void> {
    intentionalStop = true;
    try {
      const open = connection;
      if (open !== undefined && state === "ready") {
        // Ask nicely first, then stop. A server that gets to clean up avoids
        // leaving stale lock files in the workspace it was indexing.
        try {
          await withDeadline(open.sendRequest("shutdown", null, toCancellationToken(undefined)), stopGraceMs, () => undefined);
          await sendNotification(open, "exit", null);
        } catch (error) {
          options.deps.log({ serverName: spec.serverName, phase: "closed", detail: describe(error) });
        }
        // Grace before reaping: teardown kills whatever is still alive, so
        // waiting here is what lets a well-behaved server leave cleanly while
        // still bounding how long a stubborn one can hold the turn.
        await waitForExit(child, stopGraceMs);
      }

      teardown(reason);
    } finally {
      intentionalStop = false;
    }
  }

  async function waitForExit(proc: ChildProcess | undefined, timeoutMs: number): Promise<void> {
    if (proc === undefined || proc.exitCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), timeoutMs);
      timer.unref?.();
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Hand the server a file's current text. Delegates the open/change decision to
   * the synchroniser, which is the only thing that remembers the versions.
   */
  async function openDocument(document: LspDocument): Promise<LspFailure | { ok: true }> {
    const started = await start();
    if (!started.ok) {
      return started;
    }

    const open = connection;
    if (open === undefined || state !== "ready") {
      return fail("lsp_server_exited", `language server ${spec.serverName} is not running`);
    }

    const result = await documents.push(open, document);
    if (!result.ok) {
      // Reported, not thrown: a file the server will not open is usually a
      // language it does not handle, and the query that follows will say so on
      // its own terms.
      options.deps.log({ serverName: spec.serverName, phase: "ready", detail: result.message });
    }

    return { ok: true };
  }

  async function query(lspQuery: LspQuery, signal: AbortSignal): Promise<LspQueryResult> {
    if (signal.aborted) {
      return fail("lsp_cancelled", "cancelled before dispatch");
    }

    // Checked before start() on purpose: a caller that is already over the
    // concurrency ceiling should not cause a server to be launched for a query
    // that is then refused.
    if (slots.load >= limits.maxConcurrentRequests) {
      return fail(
        "lsp_limit_exceeded",
        `${spec.serverName} already has ${slots.load} requests in flight, the configured maximum of ${limits.maxConcurrentRequests}`,
      );
    }

    const started = await start();
    if (!started.ok) {
      return started;
    }

    const open = connection;
    if (open === undefined || state !== "ready") {
      return fail("lsp_server_exited", `language server ${spec.serverName} is not running`);
    }

    if (capabilities !== undefined && !serverSupports(capabilities, lspQuery.operation)) {
      return fail("lsp_unsupported", `${spec.serverName} does not provide ${lspQuery.operation}`);
    }

    const sender: RequestSender = {
      request: (method, params, requestSignal) => {
        const pending = open.sendRequest(method, params, toCancellationToken(requestSignal));
        return slots.track(pending, requestSignal);
      },
      notify: (method, params) => sendNotification(open, method, params),
    };

    try {
      const answer = await withDeadline(runOperation(sender, lspQuery, spec.workspaceRoot), limits.requestTimeoutMs, () => slots.releaseAll());
      return { ok: true, operation: lspQuery.operation, answer, truncated: false };
    } catch (error) {
      return mapLspError(error, `${lspQuery.operation} ${lspQuery.path}`);
    }
  }

  return {
    serverName: spec.serverName,
    workspaceRoot: spec.workspaceRoot,
    ensureStarted: start,
    openDocument,
    query,
    isRunning: () => state === "ready",
    close: () => stopServer("closed by owner"),
  };
}

export { describe };

/** Exported for the tool layer, which must build the same URIs the server got. */
export { pathToUri, uriToPath };
export type { LspLocation };
