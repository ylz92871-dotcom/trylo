import { createServer } from "node:http";
import type { HttpTransport } from "./transport.js";
import { validNpmName } from "./npm-tree-resolution.js";
import { fetchNpmRegistryMetadata, npmRegistryDiagnostics, npmRegistryMetadata } from "./npm-registry-metadata.js";
import { npmUnsupportedArchives } from "./npm-registry-unsupported.js";

/** npm owns dependency resolution. Its metadata transport still uses Trylo's registry boundary.
 * Only supported registry dependencies reach npm; URL/git/file dependencies and archive GETs
 * cannot turn a metadata-only lock operation into an acquisition or a script execution. */
export async function openNpmMetadataRegistry(transport: HttpTransport, signal: AbortSignal,
  selected?: { readonly name: string; readonly version: string }) {
  const controller = new AbortController(), abort = () => controller.abort(signal.reason);

  signal.addEventListener("abort", abort, { once: true });

  if (signal.aborted) abort();

  const diagnostics = npmRegistryDiagnostics(selected);
  const unsupported = npmUnsupportedArchives();
  let baseUrl: string;
  const requests = new Map<string, Promise<unknown>>();
  const server = createServer((request, response) => {
    void (async () => {
      if (controller.signal.aborted || request.method !== "GET") {
        response.writeHead(403).end();
        return;
      }

      const blocked = unsupported.requested(request.url ?? "");
      if (blocked !== undefined) {
        diagnostics.add({ packageName: blocked.packageName, version: blocked.version, stage: "selected_archive_semantics", code: blocked.code });
        response.writeHead(403).end();
        return;
      }

      let name: string;

      try { name = decodeURIComponent((request.url ?? "").slice(1)); }
      catch {
        response.writeHead(400).end();
        return;
      }

      if (!validNpmName(name) || requests.size >= 256 && !requests.has(name)) {
        response.writeHead(400).end();
        return;
      }

      let pending = requests.get(name);
      if (pending === undefined) {
        pending = fetchNpmRegistryMetadata(transport, name, controller.signal).then(result => {
          if (result.ok) return npmRegistryMetadata(name, result.value, diagnostics, binding => unsupported.block(baseUrl, binding));
          diagnostics.add({ packageName: name, stage: "metadata_fetch", code: result.code });
          return undefined;
        });
        requests.set(name, pending);
      }

      const metadata = await pending;
      if (metadata === undefined) {
        response.writeHead(502).end();
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(metadata));
    })().catch(() => { response.writeHead(502).end(); });
  });

  try { await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  }); } catch (error) {
    controller.abort();
    signal.removeEventListener("abort", abort);
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === "string") {
    controller.abort();
    signal.removeEventListener("abort", abort);
    server.close();
    throw new Error("npm_registry_unavailable");
  }

  baseUrl = `http://127.0.0.1:${address.port}/`;
  let closing: Promise<void> | undefined;

  return { url: baseUrl, diagnostics: diagnostics.read, unsupportedLock: unsupported.fromLock,
    close: () => closing ??= new Promise<void>(resolve => {
      controller.abort();
      signal.removeEventListener("abort", abort);
      server.close(() => resolve());
      server.closeAllConnections();
    }) };
}
