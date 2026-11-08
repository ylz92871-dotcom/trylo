import { spawn } from "node:child_process";
import type { RuntimeLocator } from "./files.js";
import { isRuntimeLocator } from "./files.js";
import { runtimeWorkspaceLocationMatches, type CentralRuntimeWorkspaceLocation } from "./workspace-location.js";

export type CentralRuntimeLaunch = { readonly executable: string; readonly entrypoint: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly workspaceLocation?: CentralRuntimeWorkspaceLocation };

export type CentralRuntimeActivation = "ordinary" | "recover" | "preserve";

const ACTIVATION_FAILURES = ["runtime_disabled", "runtime_intent_missing", "runtime_paused", "runtime_recovery_unclassified"] as const;

export type CentralRuntimeActivationFailure = (typeof ACTIVATION_FAILURES)[number];

export function isRuntimeActivationFailure(value: unknown): value is CentralRuntimeActivationFailure {
  return typeof value === "string" && ACTIVATION_FAILURES.some(reason => reason === value);
}

export class CentralRuntimeStartupRefusal extends Error {
  constructor(readonly reason: CentralRuntimeActivationFailure) { super(reason); }
}

export type CentralRuntimeBootstrap = { readonly schemaVersion: 1; readonly homeRoot: string;
  readonly workspaceRoot: string; readonly configuration: Readonly<Record<string, unknown>>;
  readonly workspaceLocation?: CentralRuntimeWorkspaceLocation;
  readonly activation?: CentralRuntimeActivation };

export function isCentralRuntimeActivation(value: unknown): value is CentralRuntimeActivation {
  return value === "ordinary" || value === "recover" || value === "preserve";
}

/** Both the startup client and the child holding owner.lock check current authority.
 * A live owner may be inspected without reclassifying a legacy intent; a cold
 * recovery needs the explicit durable eligibility recorded by an ordinary entry. */
export function runtimeActivationFailure(activation: CentralRuntimeActivation | undefined,
  intent: { readonly enabled: boolean; readonly recoveryPolicy?: "eligible" | "paused" } | undefined,
  phase: "existing" | "launch"): CentralRuntimeActivationFailure | undefined {
  if (intent?.enabled === false) return "runtime_disabled";
  if (activation !== "recover" && activation !== "preserve") return undefined;
  if (intent === undefined) return "runtime_intent_missing";
  if (intent.recoveryPolicy === "paused") return "runtime_paused";
  return activation === "recover" && phase === "launch" && intent.recoveryPolicy !== "eligible"
    ? "runtime_recovery_unclassified" : undefined;
}

/** The child confirms its own exclusive scope ownership before its parent can exit. */
export function launchCentralRuntime(launch: CentralRuntimeLaunch, bootstrap: CentralRuntimeBootstrap,
  scopeKey: string): Promise<RuntimeLocator> {
  const location = launch.workspaceLocation;
  const workspaceLocation = location !== undefined && runtimeWorkspaceLocationMatches(location, bootstrap.workspaceRoot, bootstrap.configuration)
    ? location : undefined;
  const child = spawn(launch.executable, [launch.entrypoint], { cwd: workspaceLocation?.physicalRoot ?? bootstrap.workspaceRoot,
    env: { ...launch.environment, TRYLO_HOME: bootstrap.homeRoot }, detached: true, windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"] });

  return new Promise((resolve, reject) => {
    let data = "", finished = false;
    const finish = (result: RuntimeLocator | Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.stdout.destroy();
      if (result instanceof Error) {
        child.kill();
        reject(result);
      }
      else {
        child.unref();
        resolve(result);
      }
    };
    const timer = setTimeout(() => finish(new Error("runtime_start_timeout")), 10000);

    child.once("error", () => finish(new Error("runtime_spawn_failed")));
    child.once("exit", () => finish(new Error("runtime_start_exited")));
    child.stdin.once("error", () => finish(new Error("runtime_bootstrap_failed")));
    child.stdout.on("data", chunk => {
      data += String(chunk);

      if (Buffer.byteLength(data) > 8192) {
        finish(new Error("runtime_ready_capacity"));
        return;
      }

      if (!data.includes("\n")) return;

      try {
        const value: unknown = JSON.parse(data.split("\n")[0] ?? "");
        if (typeof value === "object" && value !== null && "ok" in value && value.ok === false
          && "reason" in value && Object.keys(value).length === 2 && isRuntimeActivationFailure(value.reason)) {
          finish(new CentralRuntimeStartupRefusal(value.reason));
          return;
        }
        finish(isRuntimeLocator(value) && value.scopeKey === scopeKey ? value : new Error("runtime_ready_invalid"));
      } catch { finish(new Error("runtime_ready_invalid")); }
    });
    child.stdin.end(`${JSON.stringify({ ...bootstrap, ...(workspaceLocation === undefined ? {} : { workspaceLocation }) })}\n`);
  });
}
