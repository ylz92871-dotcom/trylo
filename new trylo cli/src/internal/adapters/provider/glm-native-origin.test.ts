import assert from "node:assert/strict";
import { test } from "node:test";
import { createGlmToolContinuation } from "./glm-tool-continuation.js";
import { glmContinuationBinding } from "./glm-continuation-checkpoint.js";
import { nativeContinuationNotice } from "./openai-compatible.js";
import type { ProviderMessage, ProviderRequest } from "../../ports/provider.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { SessionRecord } from "../../ports/session.js";

/**
 * WP-CL / A：来源状态。
 *
 * 旧实现把所有不在 cache 里的 assistant 消息都算作"丢失"，于是
 * (a) provider 本来就没返回原生字段的完整回答、(b) 老日志里没有来源的记录，
 * 都会被报成"丢了 N 条"。这些用例钉住的是"只有有证据的不可用才降级"。
 */

const endpoint = "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions";
const model = "glm-5.3";
const binding = glmContinuationBinding(endpoint, model);
assert.ok(binding);

const user = (content: string): ProviderMessage => ({ role: "user", content });
const assistant = (content: string): ProviderMessage => ({ role: "assistant", content });

test("an undelivered diagnostic is not suppressed merely because a request began", () => {
  const c = createGlmToolContinuation(endpoint, model);
  const checkpoint = { version: 2, binding: "other", scope: JSON.stringify(["s-unsent", "t1"]), state: "absent", identity: { text: "old", calls: [] } };
  c.persistence!.restore({ sessionId: "s-unsent", turnId: "t1", records: [envelopeRecord("s-unsent", "t1", checkpoint)] });
  const input = request(["s-unsent", "t1"], [assistant("old")]);
  assert.ok(c.begin(input)?.diagnostic);
  assert.ok(c.begin(input)?.diagnostic, "failed sends have no delivery acknowledgement");
});

test("a redacted block preceding the answer retains only its completed identity", () => {
  const c = createGlmToolContinuation(endpoint, model), input = request(["s-redacted", "t1"], []), capture = c.begin(input)!;
  capture.observe({ type: "reasoning_start", blockId: "r", redacted: true });
  capture.observe({ type: "text_delta", blockId: "b", text: "answer" });
  capture.observe({ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false });
  capture.commit();
  const saved = c.persistence!.capture(input.continuationScope!);
  assert.deepEqual(saved?.["identity"], { text: "answer", calls: [] });
  assert.equal(saved?.["assistant"], undefined);
});

function request(scope: readonly [string, string], messages: ReadonlyArray<ProviderMessage>): ProviderRequest {
  return { attemptId: "a", continuationScope: JSON.stringify([...scope]), model, messages, tools: [] };
}

function envelopeRecord(
  sessionId: string,
  turnId: string,
  providerContinuation: JsonObject,
  sequence = 1,
): SessionRecord {
  return {
    formatVersion: "1", sequence, type: "envelope", sessionId, turnId,
    at: "2026-10-17T00:00:00.000Z",
    payload: { envelope: { kind: "stream_end" }, providerContinuation },
  };
}

test("a complete response without native fields is not later reported as a loss", () => {
  const continuation = createGlmToolContinuation(endpoint, model);
  const scope = ["s-quiet", "t1"] as const;
  const first = continuation.begin(request(scope, [user("你好")]));
  assert.ok(first);
  first.observe({ type: "text_delta", blockId: "b", text: "你好，有什么可以帮你？" });
  first.observe({ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false } as never);
  first.commit();

  const next = continuation.begin(request(scope, [user("你好"), assistant("你好，有什么可以帮你？"), user("继续")]));
  assert.ok(next);
  assert.equal(next.diagnostic, undefined, "no native fields is a fact, not a degradation");
  assert.deepEqual(next.fieldsFor(assistant("你好，有什么可以帮你？")), {});
});

test("history with no journal source reports nothing and never invents a count", () => {
  const continuation = createGlmToolContinuation(endpoint, model);
  const scope = ["s-unknown", "t1"] as const;
  continuation.persistence!.restore({ sessionId: "s-unknown", turnId: "t1", records: [] });
  const messages: ProviderMessage[] = [user("历史")];
  for (let index = 1; index <= 5; index += 1) messages.push(assistant(`旧回答 ${index}`), user(`继续 ${index}`));
  const begin = continuation.begin(request(scope, messages));
  assert.ok(begin);
  assert.equal(begin.diagnostic, undefined);
});

test("an absent marker restored from the journal replays nothing and reports nothing", () => {
  const continuation = createGlmToolContinuation(endpoint, model);
  const scope = ["s-absent", "t1"] as const;
  continuation.persistence!.restore({
    sessionId: "s-absent", turnId: "t1",
    records: [envelopeRecord("s-absent", "t1", {
      version: 2, binding: binding!, scope: JSON.stringify([...scope]), state: "absent",
      identity: { text: "旧回答", calls: [] },
    })],
  });
  const begin = continuation.begin(request(scope, [user("继续"), assistant("旧回答")]));
  assert.ok(begin);
  assert.equal(begin.diagnostic, undefined);
  assert.deepEqual(begin.fieldsFor(assistant("旧回答")), {});
});

test("a checkpoint bound to another identity degrades with a traceable cause", () => {
  const continuation = createGlmToolContinuation(endpoint, model);
  const scope = ["s-binding", "t1"] as const;
  continuation.persistence!.restore({
    sessionId: "s-binding", turnId: "t1",
    records: [envelopeRecord("s-binding", "t1", {
      version: 2, binding: "some-other-binding", scope: JSON.stringify([...scope]), state: "absent",
      identity: { text: "旧回答", calls: [] },
    })],
  });
  const begin = continuation.begin(request(scope, [user("继续"), assistant("旧回答")]));
  assert.ok(begin);
  assert.equal(begin.diagnostic?.cause, "binding_mismatch");
  assert.equal(begin.diagnostic?.affected, 1);
  assert.equal(begin.diagnostic?.basis, "native_expected_occurrences");
});

test("the same degradation is delivered once across processes, not once per process", () => {
  const scope = ["s-once", "t1"] as const;
  const checkpoint = {
    version: 2, binding: "some-other-binding", scope: JSON.stringify([...scope]), state: "absent",
    identity: { text: "旧回答", calls: [] },
  };
  const firstProcess = createGlmToolContinuation(endpoint, model);
  firstProcess.persistence!.restore({
    sessionId: "s-once", turnId: "t1", records: [envelopeRecord("s-once", "t1", checkpoint)],
  });
  const first = firstProcess.begin(request(scope, [user("继续"), assistant("旧回答")]));
  assert.equal(first?.diagnostic?.cause, "binding_mismatch");

  // The second process resumes a journal that already carries the delivered notice.
  const delivered: SessionRecord = {
    formatVersion: "1", sequence: 2, type: "envelope", sessionId: "s-once", turnId: "t1",
    at: "2026-10-17T00:00:01.000Z",
    payload: {
      envelope: { kind: "observation", payload: { code: "native_continuation_unavailable",
        diagnostic: first?.diagnostic } },
      providerContinuation: checkpoint,
    },
  };
  const secondProcess = createGlmToolContinuation(endpoint, model);
  secondProcess.persistence!.restore({ sessionId: "s-once", turnId: "t2", records: [envelopeRecord("s-once", "t1", checkpoint), delivered] });
  assert.equal(secondProcess.begin(request(["s-once", "t2"], [user("继续"), assistant("旧回答")]))?.diagnostic, undefined);
});

test("a native checkpoint restored from the journal replays its exact reasoning", () => {
  const continuation = createGlmToolContinuation(endpoint, model);
  const scope = ["s-native", "t1"] as const;
  continuation.persistence!.restore({
    sessionId: "s-native", turnId: "t1",
    records: [envelopeRecord("s-native", "t1", {
      version: 2, binding: binding!, scope: JSON.stringify([...scope]), state: "native",
      assistant: { reasoning: "原生推理正文", text: "旧回答", calls: [] },
    })],
  });
  const old = assistant("旧回答");
  const begin = continuation.begin(request(scope, [user("继续"), old]));
  assert.ok(begin);
  assert.equal(begin.diagnostic, undefined);
  assert.deepEqual(begin.fieldsFor(old), { reasoning_content: "原生推理正文" });
});

test("a version-1 checkpoint from an older journal still restores", () => {
  // The old writer had no `state` field: a readable payload always meant full
  // native data. Dropping that reader would silently turn every pre-upgrade
  // session into "unknown source" on the next resume.
  const continuation = createGlmToolContinuation(endpoint, model);
  const scope = ["s-v1", "t1"] as const;
  continuation.persistence!.restore({
    sessionId: "s-v1", turnId: "t1",
    records: [envelopeRecord("s-v1", "t1", {
      version: 1, binding: binding!, scope: JSON.stringify([...scope]),
      assistant: { reasoning: "旧的推理正文", text: "旧回答", calls: [] },
    })],
  });
  const old = assistant("旧回答");
  const begin = continuation.begin(request(scope, [user("继续"), old]));
  assert.ok(begin);
  assert.equal(begin.diagnostic, undefined);
  assert.deepEqual(begin.fieldsFor(old), { reasoning_content: "旧的推理正文" });
});

test("a checkpoint the bounded cache had to evict is classified, not called unknown", () => {
  // A08: five maximum-sized native blocks exceed the character budget. That loss is
  // provable (we held it and dropped it), so it must be `cache_evicted` rather
  // than an unaccountable "unknown".
  const continuation = createGlmToolContinuation(endpoint, model);
  const scope = ["s-evict", "t1"] as const;
  const records = Array.from({ length: 5 }, (_, index) => envelopeRecord("s-evict", "t1", {
    version: 2, binding: binding!, scope: JSON.stringify([...scope]), state: "native",
    assistant: { reasoning: String(index).repeat(262_144), text: `回答 ${index}`, calls: [] },
  }, index + 1));
  continuation.persistence!.restore({ sessionId: "s-evict", turnId: "t1", records });

  const messages: ProviderMessage[] = [user("继续")];
  for (let index = 0; index < 5; index += 1) messages.push(assistant(`回答 ${index}`));
  const begin = continuation.begin(request(scope, messages));
  assert.ok(begin);
  assert.equal(begin.diagnostic?.cause, "cache_evicted");
  assert.equal(begin.diagnostic?.affected, 1);
});

test("a capture that never reached the journal is not claimed as restored", () => {
  // A15: the crash window. The response completed in memory, the process died
  // before the envelope was appended, so the next process has no record. The
  // honest answer is "unknown": no field, no diagnostic, no invented count.
  const first = createGlmToolContinuation(endpoint, model);
  const scope = ["s-crash", "t1"] as const;
  const capture = first.begin(request(scope, [user("你好")]));
  assert.ok(capture);
  capture.observe({ type: "reasoning_delta", blockId: "r", text: "会丢的推理", redacted: false });
  capture.observe({ type: "text_delta", blockId: "b", text: "会丢的回答" });
  capture.observe({ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false } as never);
  capture.commit();
  // No `persistence.capture(...)` call and no journal append: the process died.

  const second = createGlmToolContinuation(endpoint, model);
  second.persistence!.restore({ sessionId: "s-crash", turnId: "t1", records: [] });
  const lost = assistant("会丢的回答");
  const begin = second.begin(request(scope, [user("你好"), lost]));
  assert.ok(begin);
  assert.equal(begin.diagnostic, undefined, "no record means unknown, not a reported loss");
  assert.deepEqual(begin.fieldsFor(lost), {});
});

test("an unscoped auxiliary request cannot evict or erase the parent's native state", () => {
  // A10: a model-summary call runs in the middle of a paused tool turn. It has
  // no continuation scope, so it must neither read the parent cache nor push
  // anything out of it — otherwise the next beat silently loses reasoning.
  const continuation = createGlmToolContinuation(endpoint, model);
  const scope = ["s-aux", "t1"] as const;
  const parent = continuation.begin(request(scope, [user("问")]));
  assert.ok(parent);
  parent.observe({ type: "reasoning_delta", blockId: "r", text: "父请求的推理", redacted: false });
  parent.observe({ type: "text_delta", blockId: "b", text: "父回答" });
  parent.observe({ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false } as never);
  parent.commit();

  const auxiliary = continuation.begin({ attemptId: "aux", model, messages: [user("总结一下")], tools: [] });
  assert.equal(auxiliary, undefined, "an unscoped call gets no continuation at all");

  const resumed = assistant("父回答");
  const next = continuation.begin(request(scope, [user("问"), resumed, user("继续")]));
  assert.ok(next);
  assert.deepEqual(next.fieldsFor(resumed), { reasoning_content: "父请求的推理" });
  assert.equal(next.diagnostic, undefined);
});

test("the degradation notice is localized and never calls the count a lost chat", () => {
  const counted = nativeContinuationNotice({
    schemaVersion: 1, cause: "binding_mismatch", affected: 3,
    basis: "native_expected_occurrences", severity: "degraded", noticeId: "n",
  });
  assert.match(counted, /3 条/);
  assert.match(counted, /可见对话/);
  assert.doesNotMatch(counted, /Original native context/);

  const uncounted = nativeContinuationNotice({
    schemaVersion: 1, cause: "binding_mismatch", affected: 0,
    basis: "unknown", severity: "degraded", noticeId: "n",
  });
  assert.doesNotMatch(uncounted, /\d/, "an unprovable count must not appear as a number");
});

test("a different model, endpoint or session never reuses this configuration's native data", () => {
  // A07: the binding is the only thing that says "this reasoning belongs to
  // this provider configuration". Changing any part of it must make the old
  // native body unusable, and changing it to something unsupported must stop
  // retaining native data altogether rather than falling back to a looser rule.
  assert.equal(glmContinuationBinding(endpoint, "gpt-4o-mini"), undefined, "a foreign model has no binding");
  assert.equal(glmContinuationBinding("https://example.com/api/coding/v3/chat/completions", model), undefined,
    "a foreign host has no binding");
  assert.equal(glmContinuationBinding("https://ark.cn-beijing.volces.com/v1/chat/completions", model), undefined,
    "another path on the same host is a different contract");
  assert.notEqual(glmContinuationBinding(endpoint, model), glmContinuationBinding(endpoint, "glm-5.3-flash"),
    "a different model is a different binding");
  assert.equal(createGlmToolContinuation(endpoint, "gpt-4o-mini").persistence, undefined,
    "an unsupported configuration retains nothing, so it can restore nothing");

  // A checkpoint from another session is another identity's data.
  const continuation = createGlmToolContinuation(endpoint, model);
  continuation.persistence!.restore({
    sessionId: "s-a07", turnId: "t1",
    records: [envelopeRecord("s-a07", "t1", {
      version: 2, binding: binding!, scope: JSON.stringify(["s-a07", "t1"]), state: "native",
      assistant: { reasoning: "另一个会话的推理", text: "旧回答", calls: [] },
    })],
  });
  const old = assistant("旧回答");
  const elsewhere = continuation.begin(request(["s-a07-other", "t1"], [user("继续"), old]));
  assert.ok(elsewhere);
  assert.deepEqual(elsewhere.fieldsFor(old), {}, "another session's reasoning must not be replayed here");
});

test("the binding keeps no part of the endpoint it was derived from", () => {
  // A07, second half: the diagnostic travels into journals and terminals, so
  // anything endpoint-shaped in it is a credential leak. The binding is a hash
  // of the whole URL — including any query a configuration might carry.
  const withSecret = `${endpoint}?tenant=sk-live-TOPSECRET&region=cn-beijing`;
  const hashed = glmContinuationBinding(withSecret, model);
  assert.ok(hashed);
  assert.doesNotMatch(hashed!, /TOPSECRET|tenant|sk-live|volces/i);
  assert.notEqual(hashed, glmContinuationBinding(endpoint, model),
    "a different query string is a different identity");
  assert.equal(glmContinuationBinding("not a url at all", model), undefined);
});

test("a capture the provider could not keep is classified in the next process, not counted as lost", () => {
  // A09: redacted / truncated / oversized / interrupted captures are written as
  // `rejected`. A later process must be able to say "this occurrence is known
  // and has nothing to replay" — that is an explained absence, and it is the
  // whole difference between "no native data" and "we lost your context".
  const first = createGlmToolContinuation(endpoint, model);
  const scope = ["s-rejected", "t1"] as const;
  const capture = first.begin(request(scope, [user("问")]));
  assert.ok(capture);
  capture.observe({ type: "text_delta", blockId: "b", text: "旧回答" });
  capture.observe({ type: "reasoning_delta", blockId: "r", text: "脱敏的推理", redacted: true });
  capture.observe({ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false } as never);
  capture.commit();
  const captured = first.persistence!.capture(JSON.stringify([...scope]));
  assert.equal(captured?.["state"], "rejected", "a redacted capture is never written as complete");

  const second = createGlmToolContinuation(endpoint, model);
  second.persistence!.restore({
    sessionId: "s-rejected", turnId: "t1", records: [envelopeRecord("s-rejected", "t1", captured!)],
  });
  const old = assistant("旧回答");
  const begin = second.begin(request(scope, [user("问"), old]));
  assert.ok(begin);
  assert.deepEqual(begin.fieldsFor(old), {}, "a rejected capture replays nothing");
  assert.equal(begin.diagnostic, undefined, "known-and-unusable is not a reported loss");
});
