/**
 * Which request answers which question, and how our signal becomes theirs.
 *
 * Split out of `client.ts` so that file is only lifecycle. The operation table is
 * the part most likely to grow, and keeping it beside the process bookkeeping
 * made both harder to read than either needs to be.
 *
 * One rule runs through the table: an operation that asked the server and got
 * nothing back must return `{status: "empty"}`, never a fabricated answer and
 * never an error. The model is entitled to the difference between "nothing is
 * declared here" and "we could not ask".
 */

import type { LspAnswer, LspOperation, LspServerCapabilities } from "../../ports/language-server.js";
import { decodeAnswer } from "./lsp-decode.js";
import { pathToUri } from "./lsp-uri.js";
import type { RequestSender } from "./lsp-request.js";

/** The capability each operation needs. Kept beside the switch so both change together. */
const REQUIRED_CAPABILITY: Record<LspOperation, keyof LspServerCapabilities> = {
  definition: "definition",
  references: "references",
  hover: "hover",
  document_symbols: "documentSymbol",
  implementation: "implementation",
  call_hierarchy: "callHierarchy",
};

export function serverSupports(capabilities: LspServerCapabilities, operation: LspOperation): boolean {
  return capabilities[REQUIRED_CAPABILITY[operation]];
}

export async function runOperation(
  sender: RequestSender,
  query: { readonly operation: LspOperation; readonly path: string; readonly line: number; readonly character: number },
  workspaceRoot: string,
): Promise<LspAnswer> {
  const position = {
    textDocument: { uri: pathToUri(query.path, workspaceRoot) },
    position: { line: query.line, character: query.character },
  };
  switch (query.operation) {
    case "definition":
      return decodeAnswer(await sender.request("textDocument/definition", position), "definition");
    case "implementation":
      return decodeAnswer(await sender.request("textDocument/implementation", position), "implementation");
    case "references":
      return decodeAnswer(
        await sender.request("textDocument/references", { ...position, context: { includeDeclaration: true } }),
        "references",
      );
    case "hover":
      return decodeAnswer(await sender.request("textDocument/hover", position), "hover");
    case "document_symbols":
      return decodeAnswer(
        await sender.request("textDocument/documentSymbol", { textDocument: { uri: pathToUri(query.path, workspaceRoot) } }),
        "document_symbols",
      );
    case "call_hierarchy": {
      // prepare first: the protocol requires an item before either direction can
      // be asked, and an empty prepare is the honest "no call hierarchy here".
      const prepared = await sender.request("textDocument/prepareCallHierarchy", position);
      const items = Array.isArray(prepared) ? prepared : prepared === null || prepared === undefined ? [] : [prepared];
      if (items.length === 0) {
        return { status: "empty" };
      }

      // Incoming only: "who calls this" is the question a reader asks first, and
      // adding an `direction` argument now would be a second contract to freeze
      // before anything consumes it.
      return decodeAnswer(await sender.request("callHierarchy/incomingCalls", { item: items[0] }), "call_hierarchy");
    }
  }
}

/**
 * The library's cancellation token, built from our signal without letting either
 * type across the boundary. `{dispose}` is honoured so the caller can detach a
 * listener after a request settles.
 */
export function toCancellationToken(signal: AbortSignal | undefined): {
  isCancellationRequested: boolean;
  onCancellationRequested: (handler: () => void) => { dispose(): void };
} {
  return {
    get isCancellationRequested(): boolean {
      return signal?.aborted === true;
    },
    onCancellationRequested(handler: () => void): { dispose(): void } {
      if (signal === undefined) {
        return { dispose: () => undefined };
      }
      const listener = (): void => handler();
      signal.addEventListener("abort", listener, { once: true });
      return { dispose: () => signal.removeEventListener("abort", listener) };
    },
  };
}
