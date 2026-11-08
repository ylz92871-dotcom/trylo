import { artifactPath } from "../../../scripts/workspace-paths.mjs";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRealModule, realFailure, resolveRealConnection } from "./real-connection.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const build = path.resolve(root, option("build-dir") ?? "dist"), workspaceRoot = path.resolve(root, "..");
const evidence = path.resolve(option("out") ?? artifactPath("skill-learning-real", "model-catalog"));
const reportFile = path.join(evidence, "real-models.json");
let apiKey;

try {
  if (existsSync(reportFile)) throw realFailure("model_catalog_already_recorded_no_automatic_retry");

  const connection = await resolveRealConnection({ build, workspaceRoot });

  apiKey = connection.apiKey;
  const { scrubDisclosure } = await loadRealModule(build, "compaction/disclosure");
  const safe = value => typeof value === "string" || typeof value === "number"
    ? scrubDisclosure(String(value).replaceAll(apiKey, "[secret]")).slice(0, 2048) : null;
  const url = new URL(connection.endpoint);
  if (/\/chat\/completions\/?$/.test(url.pathname)) url.pathname = url.pathname.replace(/chat\/completions\/?$/, "models");
  else if (/\/responses\/?$/.test(url.pathname)) url.pathname = url.pathname.replace(/responses\/?$/, "models");
  else throw realFailure("configured_endpoint_has_no_known_standard_models_derivation");

  const startedAt = new Date().toISOString();
  // Exactly one authenticated, read-only catalogue request. No retry or generation.
  const response = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(20_000) });
  const body = await response.text();
  let parsed;

  try { parsed = JSON.parse(body); } catch { parsed = undefined; }

  const rawIds = Array.isArray(parsed?.data) ? parsed.data.map(item => item?.id).filter(id => typeof id === "string") : [];
  const ids = [...new Set(rawIds.map(safe).filter(id => typeof id === "string" && !id.includes("[secret]")))];
  const familyPrefix = connection.selected.model.split("-")[0].toLowerCase();
  const sameSeriesByName = ids.filter(id => id.toLowerCase().startsWith(familyPrefix));
  const error = parsed?.error !== null && typeof parsed?.error === "object" ? parsed.error : parsed;
  const report = { provider: connection.selected.providerId, configuredModel: connection.selected.model, directoryUrl: url.href,
    startedAt, finishedAt: new Date().toISOString(), method: "GET", networkRequests: 1, generationRequests: 0,
    httpStatus: response.status, catalogueShapeRecognized: Array.isArray(parsed?.data), modelIds: ids, sameSeriesByName,
    seriesComparisonIsNameOnly: true, configuredModelListed: ids.includes(connection.selected.model),
    error: response.ok ? null : { code: safe(error?.code), type: safe(error?.type), message: safe(typeof parsed?.error === "string" ? parsed.error : error?.message) },
    originalProfileModified: false, secretPersisted: false, rawResponsePersisted: false };

  mkdirSync(evidence, { recursive: true });
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = response.ok && Array.isArray(parsed?.data) ? 0 : 1;
} catch (error) {
  const codes = [error?.code, error?.cause?.code].filter(code => typeof code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(code));
  const report = { status: "failed", code: typeof error?.safeCode === "string" ? error.safeCode : "model_catalog_unavailable", transportCodes: codes,
    generationRequests: 0, originalProfileModified: false, secretPersisted: false };
  if (!existsSync(reportFile)) {
    mkdirSync(evidence, { recursive: true });
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = 1;
} finally { apiKey = undefined; }
