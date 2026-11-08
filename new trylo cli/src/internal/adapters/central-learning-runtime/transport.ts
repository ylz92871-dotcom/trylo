import http from "node:http";
import { randomUUID } from "node:crypto";
import type { CentralRuntimeReply, CentralRuntimeRequest } from "./contracts.js";
import { isRuntimeReply } from "./contracts.js";
import type { RuntimeLocator } from "./files.js";

/** A dropped wake is never sent again. Only its still-live original owner can
 * confirm that nonce after the original intent publication succeeded. */
export async function requestCentralRuntime(address: RuntimeLocator, input: CentralRuntimeRequest,
  signal?: AbortSignal, options: { readonly newIdentity?: () => string } = {}): Promise<CentralRuntimeReply> {
  if (signal?.aborted) return { ok: false, reason: "runtime_client_aborted" };

  if (input.operation !== "wake") return sendCentralRuntimeRequest(address, input, signal);

  const requestId = (options.newIdentity ?? randomUUID)();
  const reply = await sendCentralRuntimeRequest(address, { ...input, requestId }, signal);
  if (reply.ok || reply.reason !== "runtime_transport_unavailable") return reply;

  if (signal?.aborted) return { ok: false, reason: "runtime_client_aborted" };

  const confirmed = await sendCentralRuntimeRequest(address, { operation: "wake_receipt", requestId }, signal);

  return confirmed.ok ? confirmed : signal?.aborted ? { ok: false, reason: "runtime_client_aborted" } : reply;
}

function sendCentralRuntimeRequest(address: RuntimeLocator, input: CentralRuntimeRequest,
  signal?: AbortSignal): Promise<CentralRuntimeReply> {
  if (signal?.aborted) return Promise.resolve({ ok: false, reason: "runtime_client_aborted" });
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: CentralRuntimeReply) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const unavailable = () => finish({ ok: false, reason: signal?.aborted ? "runtime_client_aborted" : "runtime_transport_unavailable" });
    // A synchronous Board replay may delay an idle pooled socket's close
    // notification. Use a fresh local connection instead of retrying a
    // possibly accepted wake/stop after that stale connection resets.
    const request = http.request({ host: "127.0.0.1", port: address.port, path: "/runtime", method: "POST", agent: false,
      headers: { Authorization: `Bearer ${address.token}`, "Content-Type": "application/json" }, timeout: input.operation === "wait" ? 30000 : 3000 }, response => {
      let data = "";

      response.setEncoding("utf8");
      response.on("data", chunk => {
        data += String(chunk);
        if (Buffer.byteLength(data) > 16384) request.destroy(new Error("runtime_response_capacity"));
      });
      response.once("end", () => {
        try {
          const value: unknown = JSON.parse(data);
          finish(isRuntimeReply(value) && (value.ok === false || value.snapshot.ownerId === address.ownerId
            && value.snapshot.scopeKey === address.scopeKey) ? value : { ok: false, reason: "runtime_response_invalid" });
        } catch { finish({ ok: false, reason: "runtime_response_invalid" }); }
      });
      response.once("aborted", unavailable);
      response.once("error", unavailable);
      response.once("close", () => { if (!response.complete) unavailable(); });
    });
    const abort = () => request.destroy(new Error("runtime_client_aborted"));

    signal?.addEventListener("abort", abort, { once: true });
    request.once("timeout", () => request.destroy(new Error("runtime_transport_timeout")));
    request.once("error", unavailable);
    request.end(JSON.stringify(input));
  });
}
