import assert from "node:assert/strict";
import { test } from "node:test";
import { createStdioApproval } from "./stdio-control.js";
import { buildPermissionAction } from "../../loop/permission-grants.js";

test("a silent approval expires and the next request reuses the pending reader without losing its answer", async () => {
  let now = 0;
  let expire = (): void => undefined;
  let releaseLine: (value: string | undefined) => void = () => undefined;
  const pendingLine = new Promise<string | undefined>(resolve => { releaseLine = resolve; });
  let started = (): void => undefined;
  let nextStarted = (): void => undefined;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const nextStartedPromise = new Promise<void>(resolve => { nextStarted = resolve; });
  let reads = 0; let ids = 0;
  const frames: string[] = [];
  const ctx = { now: () => now, newId: () => `approval-${++ids}`,
    stdout(line: string) { frames.push(line); if (line.includes('"type":"control_request"')) { if (ids === 1) started(); else nextStarted(); } },
    readLine() { reads += 1; return pendingLine; },
  };
  const factory: (input: typeof ctx, options: { scheduleExpiry: (ms: number, action: () => void) => () => void }) => ReturnType<typeof createStdioApproval> = createStdioApproval;
  const ask = factory(ctx, { scheduleExpiry: (_ms, action) => { expire = action; return () => undefined; } });
  const first = ask(buildPermissionAction("first", "run_shell", { command: "node first.js" }));
  await startedPromise;
  now = 600_000; expire();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([first, new Promise<"no_deadline"> (resolve => { timer = setTimeout(() => resolve("no_deadline"), 100); })]);
    assert.notEqual(result, "no_deadline", "approval expiry must not wait for another input line");
    if (result === "no_deadline") return;
    assert.equal(result.resolution, "expired");
    const second = ask(buildPermissionAction("second", "run_shell", { command: "node second.js" }));
    await nextStartedPromise;
    releaseLine('{"type":"control_response","response":{"subtype":"success","request_id":"approval-2","response":{"behavior":"allow"}}}');
    assert.equal((await second).resolution, "approved");
    assert.equal(reads, 1, "an expired read must not steal the next request's response");
    assert.ok(frames.some(line => line.includes('"type":"control_cancel_request"')));
  } finally { if (timer !== undefined) clearTimeout(timer); releaseLine(undefined); await first; }
});
