import path from "node:path";
import type { CliContext } from "./context.js";
import type { ToolAcquireCommand } from "./args-tool-acquire.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { createFilePermissionStore } from "../../adapters/permission-store/file-ledger.js";
import { acquireNpmQuarantine } from "../../adapters/tool-acquisition/npm-quarantine.js";
import { decodeNpmQuarantinePlan, quarantineArchiveUrl, quarantinePlanId } from "../../adapters/tool-acquisition/npm-quarantine-plan.js";
import { permissionLedgerPath, tryloHome } from "./session-paths.js";
import { observeRunCancellation } from "./run-interrupt.js";
import { checkQuarantineAncestors, readNpmQuarantine } from "../../adapters/tool-acquisition/quarantine-files.js";

/** User-command permission entry point, never imported by the autonomous worker. */
export async function handleToolAcquire(ctx: CliContext, command: ToolAcquireCommand) {
  const raw = ctx.readFile(path.resolve(ctx.cwd, command.requestFile));
  let value: unknown;
  try { value = raw === undefined || raw.length > 32_768 ? undefined : JSON.parse(raw); }
  catch { value = undefined; }
  const plan = decodeNpmQuarantinePlan(value);
  if (plan === undefined) { ctx.stderr("invalid_acquisition_plan: expected an exact npm version, reviewed hashes, source revision and license files\n"); return EXIT_CODES.USAGE; }
  const planId = quarantinePlanId(plan), root = path.join(tryloHome(ctx.homeDir, ctx.env), "learning", "tool", "quarantine");
  if (command.kind === "acquire-plan") {
    ctx.stdout(`${JSON.stringify({ schemaVersion: 1, planId, plan, archiveUrl: quarantineArchiveUrl(plan), destination: path.join(root, planId),
      action: "download_and_unpack_only", requiredApproval: "acquire", execution: "forbidden", activation: "forbidden", profile: "dependency_free_npm_cli" })}\n`);
    return EXIT_CODES.OK;
  }
  if (command.approvedPlanId !== planId) { ctx.stderr("approval_plan_mismatch: re-review the changed request before authorizing its exact planId\n"); return EXIT_CODES.CONFIG; }
  const cancellation = observeRunCancellation(ctx);
  try {
    if (cancellation.signal.aborted) return EXIT_CODES.CANCELLED;
    await checkQuarantineAncestors(root);
    const destination = path.join(root, planId), prior = await readNpmQuarantine(destination, plan);
    if (prior !== undefined) {
      ctx.stdout(`${JSON.stringify({ ok: true, state: "quarantined", changed: false, destination, receipt: prior })}\n`);
      return EXIT_CODES.OK;
    }
    // Explicit CLI confirmation issues the grant on the Permission side. The installer only consumes its reference.
    const store = createFilePermissionStore({ path: permissionLedgerPath(ctx.homeDir, ctx.env) });
    const now = ctx.now(), issued = await store.issue({ action: "acquire", candidateId: planId, packageVersionId: planId, scope: plan.scope,
      issuedAt: new Date(now).toISOString(), expiry: new Date(now + 60_000).toISOString() });
    if (!issued.ok) { ctx.stdout(`${JSON.stringify(issued)}\n`); return EXIT_CODES.CONFIG; }
    const result = await acquireNpmQuarantine(plan, { root, approval: store, token: { grantId: issued.grant.grantId }, now: ctx.now, signal: cancellation.signal });
    ctx.stdout(`${JSON.stringify(result)}\n`);
    return result.ok ? EXIT_CODES.OK : result.code === "cancelled" ? EXIT_CODES.CANCELLED : EXIT_CODES.CONFIG;
  } catch {
    ctx.stdout(`${JSON.stringify({ ok: false, code: "quarantine_unavailable", message: "acquisition did not complete; inspect the permission ledger and retained quarantine before retrying" })}\n`);
    return EXIT_CODES.CONFIG;
  } finally { cancellation.close(); }
}
