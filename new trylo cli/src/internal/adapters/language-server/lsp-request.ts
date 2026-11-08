/**
 * Turning what the server said into what the caller is told.
 *
 * Two rules, both learned the hard way in this package:
 *
 *   - a connection error is `lsp_server_exited`, never "no results". The caller
 *     has to be able to tell a dead server from an empty project, or the model
 *     will answer "there is no such symbol" about a server that had crashed.
 *   - one translation, here. The client, the tools and the journal each mapping
 *     errors their own way is how the same failure acquires three names.
 */

import type { LspFailure } from "../../ports/language-server.js";
import { isLimitError } from "./lsp-limits.js";

/** The narrowed request surface the operation table talks to. */
export type RequestSender = {
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
};

/** JSON-RPC and protocol error codes we can name rather than echo. */
const JSON_RPC_CONNECTION_CLOSED = -32000;
const JSON_RPC_REQUEST_CANCELLED = -32800;
const JSON_RPC_CONTENT_MODIFIED = -32801;
const JSON_RPC_SERVER_NOT_INITIALIZED = -32002;

export function mapLspError(error: unknown, context: string): LspFailure {
  if (isCancellation(error)) {
    return { ok: false, code: "lsp_cancelled", message: `${context}: cancelled` };
  }

  if (isTimeout(error)) {
    return { ok: false, code: "lsp_timeout", message: `${context}: ${describe(error)}` };
  }

  if (isInvalidResult(error)) {
    return { ok: false, code: "lsp_invalid_result", message: `${context}: ${describe(error)}` };
  }

  if (isLimitError(error)) {
    return { ok: false, code: "lsp_limit_exceeded", message: `${context}: ${describe(error)}` };
  }

  if (isServerExit(error)) {
    // Checked before the numeric codes: teardown marks its own error with this
    // name, and it must land on `lsp_server_exited` so the caller knows the
    // connection state changed rather than that one request was refused.
    return { ok: false, code: "lsp_server_exited", message: `${context}: ${describe(error)}` };
  }

  const code = numericCode(error);
  if (code === JSON_RPC_REQUEST_CANCELLED) {
    return { ok: false, code: "lsp_cancelled", message: `${context}: cancelled by the server` };
  }

  if (code === JSON_RPC_CONTENT_MODIFIED) {
    // The document moved under the query. Reporting it as invalid position tells
    // the caller to re-read, which is the only thing that can help.
    return { ok: false, code: "lsp_invalid_position", message: `${context}: document changed on disk; re-read it and retry` };
  }

  if (code === JSON_RPC_CONNECTION_CLOSED || code === JSON_RPC_SERVER_NOT_INITIALIZED) {
    return { ok: false, code: "lsp_server_exited", message: `${context}: ${describe(error)}` };
  }

  if (isSpawnFailure(error)) {
    return { ok: false, code: "lsp_start_failed", message: `${context}: ${describe(error)}` };
  }

  return { ok: false, code: "lsp_start_failed", message: `${context}: ${describe(error)}` };
}

function isCancellation(error: unknown): boolean {
  const named = error instanceof Error ? error.name : "";
  if (named === "LspCancelled" || named === "ResponseError" && numericCode(error) === JSON_RPC_REQUEST_CANCELLED) {
    return true;
  }
  return error instanceof Error && /cancel/i.test(error.message);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "DeadlineExceeded";
}

function isInvalidResult(error: unknown): boolean {
  return error instanceof Error && error.name === "InvalidLspResult";
}

function isServerExit(error: unknown): boolean {
  return error instanceof Error && error.name === "LspServerExited";
}

/**
 * ENOENT on the executable is the common case, and it deserves its own code:
 * "install a language server" is a different instruction to a person than
 * "something went wrong".
 */
function isSpawnFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

function numericCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
