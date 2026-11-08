import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { requestCentralRuntime } from "./transport.js";
import type { RuntimeLocator } from "./files.js";

if (!isMainThread) {
  const address = workerData as RuntimeLocator;
  const replies = [];

  for (let index = 0; index < 3; index++) {
    const reply = await requestCentralRuntime(address, { operation: "wake", wake: { reason: "duplicate_hint", sourceRefs: [] } });
    replies.push(reply);
    if (!reply.ok) break;
  }

  parentPort!.postMessage(replies);
}
