import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Read the configured account through CredentialPort. Credentials never enter arguments, reports or learning evidence.
const root = fileURLToPath(new URL("../../", import.meta.url));
const flag = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const build = path.resolve(root, flag("build-dir") ?? "dist");
const profile = process.env.TRYLO_ACCEPTANCE_HOME ?? path.join(homedir(), ".trylo");
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const evidence = path.join(root, "docs/02-分期工程产出/P05-Experience-Learning-V0.3/evidence/2026-11-03-check-learning-v2/real", stamp);

await mkdir(evidence, { recursive: true });

const report = { schemaVersion: 1, evidenceLevel: "real configured-provider connectivity only; not checker or task acceptance", status: "not_started", events: [] };

try {
  const declarations = JSON.parse(await readFile(path.join(profile, "providers.json"), "utf8"));
  const selected = declarations.providers.find(value => value.id === declarations.selected);
  if (selected?.kind !== "openai-compatible") throw new Error("configured_provider_unsupported");

  const { createCredentialPort } = await import(pathToFileURL(path.join(build, "internal/adapters/credentials/compose.js")).href);
  const { createOpenAiCompatibleProvider } = await import(pathToFileURL(path.join(build, "internal/adapters/provider/openai-compatible.js")).href);
  const credentials = createCredentialPort({ homeDir: profile, projectDir: root, env: process.env, now: () => new Date().toISOString() });
  const resolved = credentials.getAccount({ providerId: "openai-compatible", accountId: selected.accountId });
  if (!resolved.ok) throw new Error("configured_credential_unavailable");

  const model = flag("model") ?? selected.model;

  report.provider = { id: selected.id, origin: new URL(selected.endpoint).origin, model, configuredModel: selected.model,
    modelOverride: model !== selected.model, credentialLayer: resolved.value.layer };

  if (process.argv.includes("--list-models")) {
    const url = new URL(selected.endpoint);

    url.pathname = url.pathname.replace(/\/chat\/completions\/?$/u, "/models");
    const response = await fetch(url, { headers: { authorization: `Bearer ${resolved.value.secret}` }, signal: AbortSignal.timeout(30000) });
    const body = await response.text();

    report.discovery = { status: response.status, endpointPath: url.pathname };

    if (body.length > 262144) throw new Error("model_discovery_capacity");

    const parsed = JSON.parse(body);

    report.modelIds = (Array.isArray(parsed.data) ? parsed.data : []).map(item => item.id).filter(id => typeof id === "string");
    report.status = response.ok && report.modelIds.length > 0 ? "discovery_passed" : "discovery_failed";
  } else {
  const provider = createOpenAiCompatibleProvider({ endpoint: selected.endpoint, model,
    apiKey: resolved.value.secret, maxAttemptsBeforeHeaders: 1,
    fetchImpl: async (url, options) => {
      const response = await fetch(url, options);
      if (!response.ok) {
        const diagnostic = (await response.clone().text()).slice(0, 8192).replaceAll(resolved.value.secret, "[credential]")
          .replace(/(?:Bearer\s+)[A-Za-z0-9._~+\/-]+/giu, "Bearer [credential]");
        report.httpFailure = { status: response.status, diagnostic };
      }

      return response;
    } });

  for await (const event of provider.stream({ attemptId: `check-learning-preflight:${stamp}`, model,
    messages: [{ role: "user", content: "Reply READY only." }], tools: [], maxOutputTokens: 256 }, AbortSignal.timeout(60000))) {
    if (event.type === "text_delta") report.events.push({ type: event.type, text: event.text });
    else if (event.type === "error") report.events.push({ type: event.type, class: event.class, phase: event.phase });
    else if (event.type === "finish") report.events.push({ type: event.type, reason: event.reason, requiresFollowUp: event.requiresFollowUp });
    else if (event.type === "usage") report.events.push(event);
  }

  const answer = report.events.filter(event => event.type === "text_delta").map(event => event.text).join("").trim();

  report.status = answer === "READY" && report.events.some(event => event.type === "finish" && event.reason === "stop") ? "passed" : "failed";
  }
} catch (error) {
  report.status = "failed";
  report.code = error instanceof Error && /^[a-z_]+$/u.test(error.message) ? error.message : "preflight_unavailable";
}

await writeFile(path.join(evidence, "preflight.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

process.stdout.write(`${JSON.stringify({ evidence, status: report.status, provider: report.provider ?? null, modelIds: report.modelIds })}\n`);

process.exitCode = report.status === "passed" || report.status === "discovery_passed" ? 0 : 1;
