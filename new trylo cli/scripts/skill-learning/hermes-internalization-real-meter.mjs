// A bounded observer for one explicitly selected provider. No prompts, headers,
// request bodies or credentials enter the evidence returned by this helper.
export const mechanismFailure = code => Object.assign(new Error(code), { safeCode: code });
const STAGES = { source: 4, learn: 6, reuse: 4 };
const OUTPUT_LIMIT = 8192;
const zero = () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
const add = (left, right) => Object.fromEntries(Object.keys(left).map(key => [key, left[key] + right[key]]));
const validUsage = usage => usage && (usage.mode === "snapshot" || usage.mode === "delta")
  && [usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.reasoningTokens]
    .every(value => Number.isSafeInteger(value) && value >= 0)
  && usage.totalTokens >= usage.inputTokens + usage.outputTokens;

export function createMechanismMeter({ origin, mergeUsage, emptyUsage }) {
  let stage, activeCall, failed;
  const calls = [], stages = [], originalFetch = globalThis.fetch;
  const stop = code => {
    failed ??= code;
    return mechanismFailure(failed);
  };
  const snapshot = () => ({
    stages: stages.map(item => ({ ...item, usage: { ...item.usage } })), calls: calls.map(item => ({ ...item })),
    totalCalls: calls.length, totalHttpAttempts: calls.reduce((sum, item) => sum + item.httpAttempts, 0),
    totalReportedUsage: calls.filter(item => item.usageStatus === "reported").reduce((sum, item) => add(sum, item.usage), zero()),
    totalObservedUsage: calls.filter(item => item.usageStatus !== "missing").reduce((sum, item) => add(sum, item.usage), zero()),
    usageComplete: calls.every(item => item.usageStatus === "reported"), ...(failed ? { failure: failed } : {}),
  });

  globalThis.fetch = async (url, options = {}) => {
    let requestedOrigin;

    try { requestedOrigin = new URL(typeof url === "string" || url instanceof URL ? url : url.url).origin; }
    catch { throw stop("real_request_url_invalid"); }

    if (failed || !activeCall || requestedOrigin !== origin || activeCall.httpAttempts !== 0) throw stop("real_request_outside_single_attempt_contract");

    activeCall.httpAttempts += 1;

    try {
      const response = await originalFetch(url, { ...options, redirect: "error" });
      activeCall.httpStatus = response.status;
      if (!response.ok) failed = "provider_http_failure";
      return response;
    } catch { throw stop("provider_transport_failure"); }
  };
  const guard = provider => ({
    ...(provider.continuation === undefined ? {} : { continuation: provider.continuation }),
    ...(provider.fork === undefined ? {} : { fork: messages => guard(provider.fork(messages)) }),
    async *stream(request, signal) {
      if (!activeCall && calls.some(item => item.usageStatus !== "reported")) throw stop("real_usage_missing");

      if (failed || !stage || activeCall || stage.calls >= STAGES[stage.name] || calls.length >= 14) throw stop("real_model_call_cap");

      const remaining = OUTPUT_LIMIT - stage.usage.outputTokens;
      if (remaining < 1) throw stop("real_stage_output_cap");

      const record = { index: calls.length + 1, stage: stage.name, httpAttempts: 0, httpStatus: null, usageStatus: "missing", usage: zero() };
      const owner = stage;

      calls.push(record);
      owner.calls += 1;
      activeCall = record;
      let usage = emptyUsage("snapshot"), reported = false, finished = false;
      const cancellation = new AbortController(), abort = () => cancellation.abort();

      signal.addEventListener("abort", abort, { once: true });

      if (signal.aborted) abort();

      try {
        for await (const event of provider.stream({ ...request, maxOutputTokens: Math.min(request.maxOutputTokens ?? remaining, remaining) }, cancellation.signal)) {
          if (event.type === "usage") {
            if (!validUsage(event.usage)) {
              cancellation.abort();
              throw stop("real_usage_invalid");
            }
            usage = mergeUsage(usage, event.usage);
            reported = true;
            record.usageStatus = "partial";
            record.usage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens };
            if (owner.usage.outputTokens + usage.outputTokens > OUTPUT_LIMIT) {
              cancellation.abort();
              throw stop("real_stage_output_cap");
            }
          }

          if (event.type === "error") {
            failed ??= "provider_stream_failure";
            record.providerErrorClass = event.class;
          }

          if (event.type === "finish" && event.reason !== "error" && !failed) finished = true;

          yield event;
        }

        if (!reported) throw stop(failed ?? "real_usage_missing");

        if (failed) throw mechanismFailure(failed);
      } catch (error) {
        failed ??= typeof error?.safeCode === "string" ? error.safeCode : "provider_stream_failure";
        throw mechanismFailure(failed);
      } finally {
        // The execution consumer may return as soon as it sees finish. Its
        // iterator return skips code after the loop, but cannot skip finally.
        if (!reported) failed ??= "real_usage_missing";
        else if (finished && !failed && !signal.aborted) record.usageStatus = "reported";
        else failed ??= signal.aborted ? "real_stream_cancelled" : "real_stream_incomplete";

        if (reported) owner.usage = add(owner.usage, record.usage);

        signal.removeEventListener("abort", abort);
        activeCall = undefined;
      }
    },
  });

  return {
    guard, snapshot,
    begin(name) {
      if (failed || activeCall || !(name in STAGES) || stages.some(item => item.name === name)) throw stop("real_stage_reentry_denied");
      stage = { name, calls: 0, callLimit: STAGES[name], outputTokenLimit: OUTPUT_LIMIT, usage: zero() };
      stages.push(stage);
    },
    assertHealthy() {
      if (activeCall) throw stop("real_stream_unsettled");
      if (calls.some(item => item.usageStatus !== "reported")) throw stop("real_usage_missing");
      if (failed) throw mechanismFailure(failed);
    },
    close() { globalThis.fetch = originalFetch; },
  };
}
