import http from "node:http";
import { randomUUID } from "node:crypto";
import type { CentralRuntimeDriver } from "./contracts.js";
import { isRuntimeConfiguration, isRuntimeWake, isRuntimeWakeRequestId, runtimeRecord } from "./contracts.js";
import { createCentralScopeOwner } from "./owner.js";
import { readRuntimeIntent, tryAcquireRuntimeOwner, type RuntimeScopePaths, type RuntimeOwner } from "./files.js";
import { pendingRuntimeWake } from "./startup-wake.js";

/** Loopback transport owns no semantic state. Client disconnect never aborts the scope driver. */
export async function serveCentralRuntime(options: { readonly paths: RuntimeScopePaths;
  readonly configuration: Readonly<Record<string, unknown>>; readonly driver: CentralRuntimeDriver;
  readonly newIdentity?: () => string; readonly ownerPid?: number; readonly owner?: RuntimeOwner }) {
  const acquired = options.owner === undefined ? tryAcquireRuntimeOwner(options.paths,
    options.ownerPid === undefined ? {} : { ownerPid: options.ownerPid }) : { ok: true as const, value: options.owner };
  if (!acquired.ok) throw new Error(acquired.reason);

  const store = acquired.value, newIdentity = options.newIdentity ?? randomUUID;
  const ownerId = newIdentity(), token = newIdentity();
  const existing = readRuntimeIntent(options.paths);
  if (!existing.ok) {
    store.close();
    throw new Error(existing.reason);
  }

  if (existing.value?.enabled === false) {
    store.close();
    throw new Error("runtime_disabled");
  }

  const intent = { schemaVersion: 1 as const, homeRoot: options.paths.homeRoot, workspaceRoot: existing.value?.workspaceRoot ?? options.paths.workspaceRoot,
    enabled: true, configuration: options.configuration, wakeSequence: existing.value?.wakeSequence ?? 0,
    consumedSequence: existing.value?.consumedSequence ?? 0,
    ...(pendingRuntimeWake(existing.value) ?? { wakeReason: "owner_start", sourceRefs: [] }),
    ...(existing.value?.recoveryPolicy === undefined ? {} : { recoveryPolicy: existing.value.recoveryPolicy }),
    ...(existing.value?.sourceWorkspaceRoots === undefined ? {} : { sourceWorkspaceRoots: existing.value.sourceWorkspaceRoots }) };
  const saved = store.writeIntent(intent);
  if (!saved.ok) {
    store.close();
    throw new Error(saved.reason);
  }

  const owner = createCentralScopeOwner({ scope: options.paths, ownerId, intent, store, driver: options.driver });
  let closing: Promise<void> | undefined;
  const server = http.createServer(async (request, response) => {
    const reply = (status: number, value: unknown) => {
      if (response.destroyed) return;
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(value));
    };

    if (request.method !== "POST" || request.url !== "/runtime" || request.headers.origin
      || request.headers.authorization !== `Bearer ${token}`) {
        reply(403, { ok: false, reason: "runtime_access_denied" });
        return;
      }

    try {
      let bytes = 0;
      const chunks: Buffer[] = [];

      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 65536) {
          reply(413, { ok: false, reason: "runtime_request_capacity" });
          return;
        }
        chunks.push(chunk);
      }

      const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!runtimeRecord(input)) {
        reply(400, { ok: false, reason: "runtime_request_invalid" });
        return;
      }

      if (input.operation === "status") reply(200, { ok: true, snapshot: owner.snapshot() });
      else if (input.operation === "activate") reply(200, owner.activate());
      else if (input.operation === "wake" && isRuntimeWake(input.wake)
        && (input.configuration === undefined || isRuntimeConfiguration(input.configuration))
        && (input.requestId === undefined || isRuntimeWakeRequestId(input.requestId))) {
        reply(200, owner.wake(input.wake, input.configuration, input.requestId));
      } else if (input.operation === "wake_receipt" && isRuntimeWakeRequestId(input.requestId)) {
        reply(200, owner.wakeReceipt(input.requestId));
      } else if (input.operation === "wait" && Number.isSafeInteger(input.afterRevision) && Number(input.afterRevision) >= 0) {
        // A disconnected observer cancels its wait without stopping the scope owner.
        const cancel = new AbortController(), timer = setTimeout(() => cancel.abort(), 25000);
        const disconnected = () => cancel.abort();
        response.once("close", disconnected);
        try { reply(200, { ok: true, snapshot: await owner.wait(Number(input.afterRevision), cancel.signal) }); }
        finally {
          clearTimeout(timer);
          response.removeListener("close", disconnected);
        }
      } else if (input.operation === "stop" && (input.mode === undefined || input.mode === "stop" || input.mode === "pause" || input.mode === "restart")) {
        // Reply before draining independent work. A slow driver cannot hold the caller's business turn open.
        const stopped = owner.requestClose(input.mode ?? "stop");
        response.once("finish", () => {
          void stopped.closed.then(() => close(), () => close()).catch(() => { /* The close promise remains rejected for its owning process. */ });
        });
        reply(200, stopped.receipt);
      } else reply(400, { ok: false, reason: "runtime_operation_invalid" });
    } catch { reply(500, { ok: false, reason: "runtime_request_failed" }); }
  });

  server.requestTimeout = 30000;
  server.headersTimeout = 5000;
  const close = async (mode: "stop" | "restart" = "restart"): Promise<void> => {
    const stopped = owner.requestClose(mode);

    closing ??= (async () => {
      try {
        await stopped.closed;
      } finally {
        // Complete acknowledged replies before retiring their transport; never destroy the stop receipt in flight.
        server.closeIdleConnections();
        try { await new Promise<void>(resolve => server.close(() => resolve())); }
        finally {
          store.clearLocator();
          store.close();
        }
      }
    })();
    await closing;

    if (!stopped.receipt.ok) throw new Error(stopped.receipt.reason);
  };

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const bound = server.address();
    if (bound === null || typeof bound === "string") throw new Error("runtime_address_unavailable");

    const address = { schemaVersion: 1 as const, scopeKey: options.paths.scopeKey, ownerId, pid: store.pid, port: bound.port, token };
    const published = store.writeLocator(address);
    if (!published.ok) throw new Error(published.reason);

    owner.start();

    return { address, owner, close };
  } catch (error) {
    await close();
    throw error;
  }
}
