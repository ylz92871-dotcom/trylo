import path from "node:path";
import { readExistingEnabledRuntimeScopes } from "../../adapters/central-learning-runtime/files.js";
import { notifyCentralRuntimeForSource } from "./central-runtime-notify.js";
import { tryloHome } from "./session-paths.js";
import type { CliContext } from "./context.js";

export type UserDataDeleteNotification = {
  readonly status: "sent" | "skipped" | "unconfirmed";
  readonly notifiedScopes: number;
  readonly skippedScopes: number;
  readonly issues: readonly { readonly scopeKey: string; readonly reason: string }[];
};

type Dependencies = {
  readonly discover: typeof readExistingEnabledRuntimeScopes;
  readonly notify: typeof notifyCentralRuntimeForSource;
};

/** Deletion is already committed. Re-read existing owners of this same profile;
 * no private body, synthetic feedback, new owner or budget mutation is sent. */
export async function notifyUserDataDeleted(ctx: CliContext, dependencies: Dependencies = {
  discover: readExistingEnabledRuntimeScopes, notify: notifyCentralRuntimeForSource,
}): Promise<UserDataDeleteNotification> {
  let found: ReturnType<Dependencies["discover"]>;

  try { found = dependencies.discover(path.resolve(ctx.cwd, tryloHome(ctx.homeDir, ctx.env))); }
  catch { return { status: "unconfirmed", notifiedScopes: 0, skippedScopes: 0,
    issues: [{ scopeKey: "profile", reason: "runtime_source_discovery_unavailable" }] }; }

  if (!found.ok) return { status: "unconfirmed", notifiedScopes: 0, skippedScopes: 0,
    issues: [{ scopeKey: "profile", reason: found.reason }] };

  const scopes = found.value.scopes;
  const issues = [...found.value.issues];
  let notifiedScopes = 0, skippedScopes = 0, next = 0;
  // Bound notification RPCs within the normal one-shot CLI transport deadline.
  // An unconfirmed notification cannot undo deletion or authorize a new owner.
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);

  async function worker() {
    while (next < scopes.length) {
      const scope = scopes[next++];
      if (scope === undefined) return;

      if (controller.signal.aborted) {
        issues.push({ scopeKey: scope.scopeKey, reason: "runtime_notification_deadline" });
        continue;
      }

      try {
        // Keep ctx.cwd unchanged: relative TRYLO_HOME resolves against the
        // deleting command, not independently against each workspace.
        const result = await dependencies.notify(ctx, { workspaceRoot: scope.workspaceRoot,
          reason: "explicit_user_learning_data_deleted", sourceRefs: [] }, controller.signal);
        if (!result.ok) issues.push({ scopeKey: scope.scopeKey, reason: result.reason });
        else if (result.notified) notifiedScopes++;
        else skippedScopes++;
      } catch { issues.push({ scopeKey: scope.scopeKey, reason: "runtime_source_notify_unavailable" }); }
    }
  }

  try { await Promise.all(Array.from({ length: Math.min(8, scopes.length) }, worker)); }
  finally { clearTimeout(timer); }

  return { status: issues.length > 0 ? "unconfirmed" : notifiedScopes > 0 ? "sent" : "skipped",
    notifiedScopes, skippedScopes, issues };
}
