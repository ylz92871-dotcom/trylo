import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const build = path.resolve(process.argv[2] ?? fileURLToPath(new URL("../../dist", import.meta.url)));
const base = path.resolve("docs/02-分期工程产出/P05-Experience-Learning-V0.3/evidence/2026-11-03-check-learning-v2/real");

await mkdir(base, { recursive: true }); const evidence = await mkdtemp(path.join(base, "native-probe-"));
const { createApprovedCheckerExecutor } = await import(pathToFileURL(path.join(build, "internal/surface/cli/check-learning-runtime.js")).href);
const { checkerAsToolCandidate, requirementDigest } = await import(pathToFileURL(path.join(build, "internal/learning/check/v2/parse.js")).href);
const digest = requirementDigest({ text: "Quantity is nonnegative, including zero." });
const checker = { schemaVersion: 2, type: "learned_checker", question: "Fixed first-party confinement probe", claim: "Probe only; not a learned asset.",
  applicability: { scope: "native-probe", requirementRef: "probe:quantity", requirementDigest: digest, requiredKeys: [], excludedKeys: [], instructionIncludes: [] },
  timing: ["before_completion"], sourceRefs: ["first-party-probe"],
  source: 'module.exports = input => ({status: input.output.qty >= 0 ? "pass" : "fail",findings: input.output.qty >= 0 ? [] : [{requirementRef:input.task.requirementRef,message:"negative quantity"}]});' };
const actions = [];
// Explicit experimental parent grant for this fixed source. Continuous acceptance separately exercises the real Permission Service.
const permission = { request: async action => {
  actions.push({ name: action.name, pattern: action.pattern });
  return { ticketId: "native-probe-once", toolCallId: action.toolCallId };
},
  awaitDecision: async () => ({ resolution: "approved", scope: "once" }) };
const executor = createApprovedCheckerExecutor({ permission, homeDir: evidence, env: { ...process.env, TRYLO_HOME: evidence } });
const started = Date.now();
const result = await executor.execute(checkerAsToolCandidate(checker), { task: { instruction: "Probe zero.", requirementRef: "probe:quantity", requirementDigest: digest },
  phase: "before_completion", output: { qty: 0 } }, AbortSignal.timeout(60000));
const report = { boundary: "fixed first-party code; production approved executor and native Windows isolation; no model call, no learned-method claim", elapsedMs: Date.now() - started, actions, result };

await writeFile(path.join(evidence, "probe.json"), JSON.stringify(report, null, 2));

console.log(JSON.stringify({ evidence, ...report }));

process.exitCode = result.kind === "value" && result.value.status === "pass" ? 0 : 1;
