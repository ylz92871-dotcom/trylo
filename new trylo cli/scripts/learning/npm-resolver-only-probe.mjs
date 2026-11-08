// Explicitly invoked acceptance probe: metadata + the user's npm only. No model, tarball, install, grant or activation.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { temporaryPath } from "../../../scripts/workspace-paths.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputRoot = path.resolve(process.argv[2] ?? path.join(projectRoot, "dist"));
const scratchRoot = path.resolve(process.argv[3] ?? temporaryPath("new-cli-probes", "npm-resolver-only-probe"));
const moduleRoot = path.join(outputRoot, "internal/learning/agent/subsystems/tool/adapters/acquisition");
const load = name => import(pathToFileURL(path.join(moduleRoot, `${name}.js`)).href);
const [{ resolveNpmLearningLock, locateNpmCli }, { createHttpsTransport }, { hostNpmTarget }] = await Promise.all([
  load("npm-lock-resolver"), load("transport"), load("npm-platform"),
]);
const npmCli = await locateNpmCli(process.execPath, process.env.PATH ?? process.env.Path ?? "");

assert.ok(npmCli, "The explicit resolver probe requires the existing npm CLI");

const http = createHttpsTransport(), calls = [];
const transport = { get: async request => {
  calls.push({ url: request.url, accept: request.headers.accept });
  assert.ok(!request.url.endsWith(".tgz"), "Resolver-only acceptance must never download an archive");
  assert.equal(new URL(request.url).hostname, "registry.npmjs.org");
  assert.equal(request.headers.accept, "application/vnd.npm.install-v1+json");
  return http.get(request);
} };
const result = await resolveNpmLearningLock({ scope: "TEST_ONLY_explicit_resolver_acceptance", name: "is-odd", version: "3.0.1",
  target: hostNpmTarget(), signal: new AbortController().signal, transport,
  host: { nodeExecutable: process.execPath, npmCli, scratchRoot,
    ...(process.env.SystemRoot === undefined ? {} : { systemRoot: process.env.SystemRoot }) } });
if (!result.ok) {
  console.log(JSON.stringify({ ...result, modelCalls: 0, archivesDownloaded: 0, installed: false, activated: false }));
  process.exitCode = 1;
}
else {
  const root = result.tree.packages.find(row => row.location === result.tree.root.location);

  assert.equal(root?.name, "is-odd");
  assert.equal(root?.version, "3.0.1");
  const dependency = root.edges.find(row => row.name === "is-number");
  assert.ok(dependency);
  assert.equal(dependency.resolution.kind, "package");
  assert.ok(result.tree.packages.some(row => row.location === dependency.resolution.location && row.name === "is-number"));
  assert.ok(result.tree.packages.length >= 2);
  assert.ok(calls.length >= 2);
  console.log(JSON.stringify({ ok: true, scope: "resolver_only", npmCli, lockfileVersion: result.lock.lockfileVersion,
    root: result.tree.root, packages: result.tree.packages.map(({ name, version, location }) => ({ name, version, location })),
    metadataRequests: calls.length, modelCalls: 0, archivesDownloaded: 0, installed: false, activated: false }));
}
