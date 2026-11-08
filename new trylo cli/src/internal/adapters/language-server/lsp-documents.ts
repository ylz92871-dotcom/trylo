/**
 * Keeping a language server's copy of a file current.
 *
 * Split out of `client.ts` because it owns something the connection does not:
 * the *version history* of every document the server has been shown. That state
 * is what decides between `didOpen` and `didChange`, and getting it wrong is
 * silent — the protocol treats a second `didOpen` for a held URI as an error,
 * and a server that receives one may simply stop tracking the file.
 *
 * Why it matters beyond tidiness: a language server resolves positions against
 * the documents it has been shown. A query about a file it never received comes
 * back as a confident empty answer, which reads as a fact about the code.
 * Handing it the text first is the difference between "no definition here" and
 * "I never looked".
 */

import type { MessageConnection } from "vscode-jsonrpc/node";
import { pathToUri } from "./lsp-uri.js";
import { describe } from "./lsp-failure-text.js";

/** What the caller does with a failure. Kept here so this module owns no policy. */
export type DocumentSyncOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export class DocumentSynchroniser {
  /** URI -> the version the server last saw. The whole point of this class. */
  private readonly versions = new Map<string, number>();

  /**
   * The workspace every relative document path resolves against. Held here
   * because the URIs handed to the server must name files on this disk, and
   * a converter that invents `file:///b.ts` for a relative path asks about a
   * phantom document instead.
   */
  constructor(private readonly workspaceRoot: string) {}

  /**
   * `didOpen` the first time, `didChange` after that.
   *
   * A picker queries the same file repeatedly, so the second call is the common
   * case, not the exception.
   */
  async push(
    open: MessageConnection,
    document: { readonly path: string; readonly languageId: string; readonly text: string; readonly version?: number },
  ): Promise<DocumentSyncOutcome> {
    const known = this.versions.get(document.path);
    if (known !== undefined) {
      return this.change(open, document, known + 1);
    }
    return this.open(open, document);
  }

  /**
   * Forget everything. Called when the connection dies: a new server has never
   * seen these documents, so replaying a `didChange` would ask it to update a
   * file it never opened.
   */
  reset(): void {
    this.versions.clear();
  }

  /** How many documents the server currently holds. For tests and diagnostics. */
  get heldCount(): number {
    return this.versions.size;
  }

  private async open(
    open: MessageConnection,
    document: { readonly path: string; readonly languageId: string; readonly text: string; readonly version?: number },
  ): Promise<DocumentSyncOutcome> {
    try {
      await open.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: pathToUri(document.path, this.workspaceRoot),
          languageId: document.languageId,
          version: document.version ?? 1,
          text: document.text,
        },
      });
      this.versions.set(document.path, document.version ?? 1);

      return { ok: true };
    } catch (error) {
      // Not fatal to the connection: the server may simply not handle that
      // language. The query then fails on its own terms rather than silently
      // answering about a document the server never received — and the caller
      // is not told the file was "opened" when it was not.
      return { ok: false, message: `didOpen failed for ${document.path}: ${describe(error)}` };
    }
  }

  private async change(
    open: MessageConnection,
    document: { readonly path: string; readonly text: string },
    version: number,
  ): Promise<DocumentSyncOutcome> {
    try {
      await open.sendNotification("textDocument/didChange", {
        textDocument: { uri: pathToUri(document.path, this.workspaceRoot), version },
        contentChanges: [{ text: document.text }],
      });
      this.versions.set(document.path, version);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: `didChange failed for ${document.path}: ${describe(error)}` };
    }
  }
}
