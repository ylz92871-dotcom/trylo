import path from "node:path";
import type { CliContext } from "./context.js";
import type { ToolInstallCommand } from "./args-tool-install.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { decodeNpmInstallPlan, npmInstallId } from "../../adapters/tool-acquisition/npm-install-plan.js";
import { installNpmTree, npmInstallErrorCode } from "../../adapters/tool-acquisition/npm-install.js";
import { readNpmInstall, readNpmInstallStaging } from "../../adapters/tool-acquisition/npm-install-files.js";
import { hostNpmTarget } from "../../adapters/tool-acquisition/npm-platform.js";
import { createFilePermissionStore } from "../../adapters/permission-store/file-ledger.js";
import { permissionLedgerPath, tryloHome } from "./session-paths.js";
import { observeRunCancellation } from "./run-interrupt.js";
import { workspaceIdentity } from "./wiring.js";
import { createNpmToolProductionPlan, decodeNpmToolInterface } from "../../learning/domains/tool/evolution/npm-production-plan.js";
import { parseToolEvolutionRequest } from "../../learning/domains/tool/evolution/parse.js";
import { saveToolProductionPlan } from "../../integration/tool-learning/production-assets.js";
import { authorizeToolCheck } from "./tool-check-permission.js";
import { contentHashOf } from "../../learning/control/hash.js";

/** Explicit operator surface. Learning workers cannot issue acquisition grants or infer activation. */
export async function handleToolInstall(ctx: CliContext, command: ToolInstallCommand): Promise<ExitCode> {
  const home = tryloHome(ctx.homeDir, ctx.env), root = path.join(home, "learning", "tool", "installations");
  const print = <T extends { readonly ok: boolean }>(result: T): ExitCode => { ctx.stdout(`${JSON.stringify(result)}\n`); return result.ok ? EXIT_CODES.OK : EXIT_CODES.CONFIG; };
  const cancellation = observeRunCancellation(ctx);
  try {
    if (command.kind === "install-show" || command.kind === "install-production" || command.kind === "install-inspect") {
      return await handleInstalled(ctx, command, root, cancellation.signal, print);
    }
    const plan = decodeNpmInstallPlan(readJson(ctx, command.requestFile));
    if (plan === undefined) return print({ ok: false, code: "invalid_npm_install_plan", message: "expected a v3 lock, exact runtime tree and reviewed archive/manifest/license/source records for every location" });
    const planId = npmInstallId(plan);
    if (command.kind === "install-plan") return print({ ok: true, planId, plan, target: hostNpmTarget(), destination: path.join(root, planId),
      action: "download_verify_and_materialize_private_tree", requiredApproval: "acquire", hooks: "forbidden", execution: "forbidden", activation: "forbidden" });
    if (command.approvedPlanId !== planId) return print({ ok: false, code: "approval_plan_mismatch" });
    if (contentHashOf(plan.tree.target) !== contentHashOf(hostNpmTarget())) return print({ ok: false, code: "npm_install_target_mismatch" });
    if (cancellation.signal.aborted) return EXIT_CODES.CANCELLED;
    const prior = await readNpmInstall(path.join(root, planId), plan);
    if (prior !== undefined) return print({ ok: true, state: "installed", changed: false, receipt: prior.receipt });
    const store = createFilePermissionStore({ path: permissionLedgerPath(ctx.homeDir, ctx.env) }), now = ctx.now();
    const grant = await store.issue({ action: "acquire", candidateId: planId, packageVersionId: planId, scope: plan.tree.scope,
      issuedAt: new Date(now).toISOString(), expiry: new Date(now + 120_000).toISOString() });
    if (!grant.ok) return print(grant);
    const result = await installNpmTree(plan, { root, target: hostNpmTarget(), approval: store, token: { grantId: grant.grant.grantId }, now: ctx.now, signal: cancellation.signal });
    if (!result.ok && result.code === "cancelled") { ctx.stdout(`${JSON.stringify(result)}\n`); return EXIT_CODES.CANCELLED; }
    return print(result);
  } catch (error) {
    if (cancellation.signal.aborted) { ctx.stdout(`${JSON.stringify({ ok: false, code: "cancelled" })}\n`); return EXIT_CODES.CANCELLED; }
    return print({ ok: false, code: npmInstallErrorCode(error), message: "installation or source inspection failed; retained bytes, staging and permission history were not replaced" });
  } finally { cancellation.close(); }
}
type InstalledCommand = Extract<ToolInstallCommand, { readonly kind: "install-show" | "install-production" | "install-inspect" }>;
type PrintResult = <T extends { readonly ok: boolean }>(result: T) => ExitCode;

async function handleInstalled(ctx: CliContext, command: InstalledCommand, root: string, signal: AbortSignal, print: PrintResult): Promise<ExitCode> {
  const destination = path.join(root, command.planId), installed = await readNpmInstall(destination);
  if (signal.aborted) return EXIT_CODES.CANCELLED;
  if (installed === undefined && command.kind === "install-show") {
    const staged = await readNpmInstallStaging(destination);
    if (staged !== undefined && staged.receipt.planId === command.planId) return print({ ok: true, state: "staged_pending_publication", receipt: staged.receipt, published: false,
      execution: "not_granted_by_installation", activation: "not_granted_by_installation" });
  }
  if (installed === undefined || installed.receipt.planId !== command.planId) return print({ ok: false, code: "npm_install_not_found" });
  if (command.kind === "install-show") return print({ ok: true, receipt: installed.receipt, execution: "not_granted_by_installation", activation: "not_granted_by_installation" });
  if (command.kind === "install-inspect") {
    const inspect = ctx.toolProduction?.inspectInstallation;
    if (inspect === undefined) return print({ ok: false, code: "npm_inspector_unavailable" });
    ctx.stderr(`Inspect MCP installation ${command.planId}, bin ${command.bin}; initialize and list only.\n`);
    if (!(await authorizeToolCheck(ctx, command.run, { installationId: command.planId, bin: command.bin, protocolVersion: command.protocolVersion }, signal))) {
      const exit = print({ ok: false, code: "npm_inspection_not_authorized" }); return signal.aborted ? EXIT_CODES.CANCELLED : exit;
    }
    const inspected = await inspect(installed.receipt.plan, command.bin, command.protocolVersion, signal);
    const result = { ok: inspected.kind === "value", state: "inspection_only", result: inspected, verified: false, activated: false };
    if (inspected.kind === "cancelled") { ctx.stdout(`${JSON.stringify(result)}\n`); return EXIT_CODES.CANCELLED; }
    return print(result);
  }
  const selected = decodeNpmToolInterface(readJson(ctx, command.interfaceFile)), checks = parseToolEvolutionRequest(readJson(ctx, command.checksFile));
  if (selected === undefined || !checks.ok) return print({ ok: false, code: "invalid_npm_production_interface_or_checks" });
  const plan = createNpmToolProductionPlan({ workspaceId: workspaceIdentity(path.resolve(ctx.cwd)), installation: installed.receipt.plan, ...selected, checks: checks.value });
  if (plan === undefined) return print({ ok: false, code: "invalid_npm_production_plan" });
  const home = tryloHome(ctx.homeDir, ctx.env);
  return print(await saveToolProductionPlan(path.join(home, "learning", "board"), plan, new Date(ctx.now()).toISOString()));
}
function readJson(ctx: CliContext, relative: string): unknown {
  const text = ctx.readFile(path.resolve(ctx.cwd, relative));
  try { return text === undefined || Buffer.byteLength(text) > 2 * 1024 * 1024 ? undefined : JSON.parse(text); }
  catch { return undefined; }
}
