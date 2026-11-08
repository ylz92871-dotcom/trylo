import assert from "node:assert/strict";
import { test } from "node:test";
import { decision, type PermissionAction } from "../permission.js";
import { tuiApprovalCallbacks } from "./approval-ui.js";

test("one failed overlapping approval cannot resume another waiting panel", () => {
  let resumes = 0;
  const callbacks = tuiApprovalCallbacks({ readLine: async () => undefined, write: () => {}, size: () => ({ rows: 24, columns: 80 }) }, {
    current: { pause: () => {}, resume: () => { resumes++; }, request: () => {}, settle: () => {} },
  });
  const first: PermissionAction = { name: "write_file", toolCallId: "first", arguments: {}, pattern: "first" };
  // Independent providers may reuse the same tool call id.
  const second: PermissionAction = { ...first };

  callbacks.onApproval?.({ kind: "waiting", action: first });
  callbacks.onApproval?.({ kind: "waiting", action: second });
  callbacks.onApproval?.({ kind: "failed", action: second });
  assert.equal(resumes, 0);
  callbacks.onApproval?.({ kind: "settled", action: first, decision: decision("denied", "once") });
  assert.equal(resumes, 1);
});
