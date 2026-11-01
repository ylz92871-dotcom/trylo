import assert from "node:assert/strict";
import { test } from "node:test";
import { createInteractivePermission, type ApprovalLifecycle } from "./permission.js";
import { permissionPattern } from "../../ports/permission.js";

test("cancelling a text approval settles promptly and a late yes cannot approve it", async () => {
  const controller = new AbortController();
  const events: ApprovalLifecycle[] = [];
  let answer!: (line: string) => void;
  const port = createInteractivePermission({
    prompt: () => {},
    readLine: () => new Promise(resolve => { answer = resolve; }),
    onApproval: event => { events.push(event); },
  });
  const ticket = await port.request({ toolCallId: "candidate-check", name: "run_shell", arguments: {}, pattern: permissionPattern("run_shell", {}) }, { signal: controller.signal });
  const pending = port.awaitDecision(ticket.ticketId);
  controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"still_waiting">(resolve => { timer = setTimeout(() => { resolve("still_waiting"); }, 200); });
  const result = await Promise.race([pending, timeout]);
  clearTimeout(timer);
  answer("y");
  assert.notEqual(result, "still_waiting", "abort must release the text approval without another input line");
  assert.equal((await pending).resolution, "cancelled");
  assert.deepEqual(events.map(event => event.kind), ["waiting", "settled"]);
  assert.equal(events[1]?.kind === "settled" && events[1].decision.resolution, "cancelled");
  await assert.rejects(port.awaitDecision(ticket.ticketId), /unknown approval ticket/);
});
