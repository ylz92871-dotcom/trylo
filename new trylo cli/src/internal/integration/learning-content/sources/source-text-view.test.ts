import { test } from "node:test";
import assert from "node:assert/strict";
import { contentHashOf } from "../../../learning/control/hash.js";
import { isRedactedTopicData } from "../../learning-topics/confidentiality.js";
import { projectContentSourceText, contentSourceViewContext, readContentSourceViewContext } from "./source-text-view.js";

const source = (text: string) => ({ ref: "original:user:1", runId: "session:original", sequence: 1,
  scope: "D:\\CC\\trylo", origin: "user_statement" as const, text });

test("coding source views retain relative file roles with a distinct identity and the original source hash", () => {
  const record = source("Copy D:\\CC\\trylo\\src\\a.ts to D:\\CC\\trylo\\src\\b.ts, preserving the old contract.");

  assert.equal(isRedactedTopicData(record.text, []), false);
  const view = projectContentSourceText(record);

  assert.equal(view.changed, true);
  assert.notEqual(view.record.ref, record.ref);
  assert.equal(view.record.text, "Copy <workspace>\\src\\a.ts to <workspace>\\src\\b.ts, preserving the old contract.");
  assert.equal(isRedactedTopicData(view.record.text, []), true);
  assert.equal(view.original.sourceHash, contentHashOf(record.text));
  assert.equal(view.record.runId, view.record.ref);
  assert.equal(record.text, "Copy D:\\CC\\trylo\\src\\a.ts to D:\\CC\\trylo\\src\\b.ts, preserving the old contract.");
  const context = contentSourceViewContext(view, "Original canonical journal metadata.");

  assert.equal(readContentSourceViewContext(context, view.record)?.originalRef, record.ref);
  assert.equal(readContentSourceViewContext(context, { ...view.record, text: view.record.text + " altered" }), undefined);
});

test("known credentials, external paths and serialized workspace paths retain the original redaction policy", () => {
  const view = projectContentSourceText(source('Read {"cwd":"D:\\\\CC\\\\trylo\\\\src"}; password=not-visible and D:\\private\\outside.'), []);

  assert.ok(view.record.text.includes("<workspace>"));
  assert.ok(!view.record.text.includes("D:"));
  assert.equal(isRedactedTopicData(view.record.text, []), true);
  const credential = projectContentSourceText(source("Literal known-provider-value must not enter learning."), ["known-provider-value"]);

  assert.ok(!credential.record.text.includes("known-provider-value"));
  assert.equal(isRedactedTopicData(credential.record.text, ["known-provider-value"]), true);
  const other = projectContentSourceText(source("Read D:\\CC\\trylo-other\\private.txt."));

  assert.ok(!other.record.text.includes("<workspace>"));
  const clean = source("The original relative src/a.ts requirement.");
  assert.equal(projectContentSourceText(clean).record, clean);
  assert.equal(projectContentSourceText({ ...source("Read D:\\src\\a.ts."), scope: "D:\\" }).record.text, "Read <workspace>\\src\\a.ts.");
  assert.ok(!projectContentSourceText({ ...source("Read /home/USER/repo/private.ts."), scope: "/home/user/repo" }).record.text.includes("<workspace>"));
});
