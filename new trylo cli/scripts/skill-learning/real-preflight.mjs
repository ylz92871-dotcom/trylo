import { artifactPath } from "../../../scripts/workspace-paths.mjs";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { realFailure as failure, resolveRealConnection } from "./real-connection.mjs";

// Connectivity only. This may use an older built CLI, deliberately independent
// from the new skill runtime; the exact entry hash is recorded in the report.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(scriptDir, "../.."), workspaceRoot = path.resolve(cliRoot, "..");
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const build = path.resolve(cliRoot, arg("build-dir") ?? "dist");
const evidence = path.resolve(arg("out") ?? artifactPath("skill-learning-real", "preflight"));
const inspectOnly = process.argv.includes("--inspect-only");
let secret;

const save = (name, value) => {
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, name), `${JSON.stringify(value, null, 2)}\n`);
};

async function main() {
  if (!inspectOnly && existsSync(path.join(evidence, "real-preflight.json"))) throw failure("preflight_already_recorded_no_automatic_retry");

  const { selected, endpoint, apiKey, configuredModel } = await resolveRealConnection({ build, workspaceRoot, modelOverride: arg("model") });

  secret = apiKey;
  const entry = path.join(build, "cmd/trylo/main.js");
  const entryHash = createHash("sha256").update(readFileSync(entry)).digest("hex");
  const publicSelection = { provider: selected.providerId, kind: selected.kind, configuredModel, model: selected.model, modelOverride: configuredModel !== selected.model, origin: endpoint.origin,
    credentialResolved: true, credentialResolver: "normal runCredentialFor / CredentialPort", cliEntrySha256: entryHash,
    cliEntryModifiedAt: statSync(entry).mtime.toISOString(), scope: "provider-connectivity-only; new-skill-runtime-not-exercised" };

  if (inspectOnly) {
    save("real-preflight-inspection.json", publicSelection);
    process.stdout.write(`${JSON.stringify(publicSelection)}\n`);
    return;
  }

  const profile = path.join(evidence, "isolated-profile"), cwd = path.join(evidence, "isolated-workspace");

  mkdirSync(profile, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  // This public declaration intentionally has no accountId: the already
  // resolved secret enters only the child's documented scoped env variable.
  const id = "preflight-selected";

  writeFileSync(path.join(profile, "providers.json"), JSON.stringify({ version: 1, selected: id, providers: [{
    id, kind: selected.kind, endpoint: selected.endpoint, model: selected.model,
    streaming: true, tools: false, reasoning: selected.capabilities.reasoning, cancellation: true,
  }] }, null, 2));
  const args = ["--import", pathToFileURL(path.join(scriptDir, "real-preflight-observer.mjs")).href, entry, "run",
    "--workspace", cwd, "--tools", "none", "--max-iterations", "1", "--max-tokens", "128",
    "--format", "stream-json", "--system-prompt", "This is a connection check. Reply READY only. Do not use tools or explain.", "Reply READY only."];
  const startedAt = new Date().toISOString();
  const child = await runChild(args, cwd, { ...process.env, TRYLO_HOME: profile, TRYLO_OPENAI_API_KEY: secret });
  const sanitized = summarizeChild(child);
  const report = { ...publicSelection, startedAt, finishedAt: new Date().toISOString(), maxOutputTokens: 128, maxIterations: 1,
    tools: [], isolatedProfile: profile, originalProfileUnchangedByDesign: true, ...sanitized };

  save("real-preflight.json", report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = sanitized.cliExitCode ?? 1;
}

function runChild(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false, overflow = false;
    const consume = (field, chunk) => {
      if (field === "stdout") stdout += chunk;else stderr += chunk;
      if (stdout.length + stderr.length > 1_048_576) {
        overflow = true;
        child.kill();
      }
    };

    child.stdout.on("data", chunk => consume("stdout", chunk));
    child.stderr.on("data", chunk => consume("stderr", chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 60_000);

    child.once("error", () => {
      clearTimeout(timer);
      reject(failure("preflight_child_spawn_failed"));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, overflow });
    });
  });
}

function summarizeChild(child) {
  const frames = child.stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const final = frames.findLast(frame => frame?.type === "run_result");
  const start = frames.find(frame => frame?.type === "run_start");
  const telemetryLine = child.stderr.split(/\r?\n/).find(line => line.startsWith("TRYLO_REAL_PREFLIGHT_TELEMETRY "));
  let telemetry;

  try { telemetry = telemetryLine === undefined ? undefined : JSON.parse(telemetryLine.slice("TRYLO_REAL_PREFLIGHT_TELEMETRY ".length)); }
  catch { /* Missing/invalid telemetry remains unknown; raw stderr is never persisted. */ }

  const reportedUsage = frames.some(frame => frame?.type === "usage");
  const publicUsage = reportedUsage && final?.usage && ["inputTokens", "outputTokens", "totalTokens"].every(key => Number.isFinite(final.usage[key]))
    ? { inputTokens: final.usage.inputTokens, outputTokens: final.usage.outputTokens, totalTokens: final.usage.totalTokens } : undefined;
  const ready = typeof final?.lastMessage === "string" && final.lastMessage.trim() === "READY";

  return { cliExitCode: child.code, childSignal: child.signal, timedOut: child.timedOut, overflow: child.overflow,
    runStatus: final?.status ?? "unavailable", finishReason: final?.finishReason ?? "unavailable", iterations: final?.iterations ?? null,
    effectiveProvider: start?.providerId ?? null, effectiveModel: start?.model ?? null,
    ready, responseTextChars: typeof final?.lastMessage === "string" ? final.lastMessage.length : null,
    usageStatus: publicUsage === undefined ? "missing" : "reported",
    usage: publicUsage ?? null, warningCodes: [...new Set(frames.filter(frame => frame?.type === "warning").map(frame => frame.code).filter(value => typeof value === "string"))],
    telemetry: telemetry ?? null, rawOutputPersisted: false,
    startupErrorCodes: [...new Set(child.stderr.match(/\bERR_[A-Z_]+\b/g) ?? [])],
    outcome: ready && child.code === 0 ? "ready" : telemetry?.statuses?.some(status => status >= 200 && status < 300) ? "connected_without_ready_completion" : "connection_failed" };
}

try { await main(); }
catch (error) {
  // Error messages/stacks from credentials or transport may contain private
  // material. Only codes created by this runner can leave the process.
  const report = { status: "failed", code: typeof error?.safeCode === "string" ? error.safeCode : "preflight_unavailable",
    scope: "provider-connectivity-only; new-skill-runtime-not-exercised", secretPersisted: false };
  if (!inspectOnly && !existsSync(path.join(evidence, "real-preflight.json"))) save("real-preflight.json", report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = 1;
} finally { secret = undefined; }
