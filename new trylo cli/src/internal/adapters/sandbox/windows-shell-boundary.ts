import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ShellSpawnSpec, ShellSpawner } from "../tools/mutating/shell-spawn.js";
import { childEnvironment } from "../tools/mutating/shell-spawn.js";
import { DISPATCH_ARG } from "./sandbox-vendor.js";
import { prepareWindowsHelper } from "./windows-helper-cache.js";
import { prepareWindowsIsolation } from "./windows-readiness.js";
import { resolveExecutablePath } from "./resolve-executable-path.js";
import type { WindowsAclLease } from "./windows-acl-lease.js";
import { windowsHelperEnvironment } from "./windows-helper-environment.js";
import { hostNodeExecutable, type CommandShape } from "./executable.js";
import { ShellIsolationError } from "../../ports/isolation.js";
import { captureWindowsStdinBridge } from "./windows-stdin-bridge.js";

function pinExecutable(argv: readonly string[]): readonly string[] {
  const program = argv[0];
  if (program === undefined) throw new Error("isolation_refused: no planned executable");
  const resolved = resolveExecutablePath(program);
  if (!resolved.ok || resolved.needsShell) throw new Error(`isolation_refused: ${resolved.ok ? "batch program must be shaped through the command interpreter" : resolved.message}`);
  return [resolved.absolutePath, ...argv.slice(1)];
}

/** One ACL lease for the prepared session, after all its children have drained. */
export function createWindowsShellBoundary(workspaceRoot: string, hostEnvironment: Readonly<Record<string, string | undefined>>, prepareLease?: () => Promise<WindowsAclLease>) {
  const publishStdinBridge = captureWindowsStdinBridge();
  let stdinBridge: ReturnType<typeof publishStdinBridge> | undefined;
  let prepared: Promise<WindowsAclLease> | undefined;
  let closing = false;
  const initialise = async () => {
    const helperPath = prepareWindowsHelper(hostEnvironment, [workspaceRoot]);
    const ready = await prepareWindowsIsolation([workspaceRoot], { helperPath }, () => closing);
    const availability = ready.availability;
    if (availability.state !== "ready") {
      throw new ShellIsolationError(`isolation_${availability.state}`, `command was not run; ${availability.state === "not_installed" ? availability.installHint : "reason" in availability ? availability.reason : "sandbox not ready"}`);
    }
    if (ready.lease === undefined) throw new Error("isolation_broken: readiness returned no ACL owner");
    return ready.lease;
  };
  const wrap = async (argv: readonly string[], readablePrograms: readonly string[] = []): Promise<readonly string[]> => {
    if (closing) throw new ShellIsolationError("isolation_closed", "command was not run");
    windowsHelperEnvironment(hostEnvironment);
    // Reuse the PTY resolver: the restricted logon cannot search the host PATH.
    // Admission still sees the original command; lookup only pins what it runs.
    const pinned = pinExecutable(argv);
    let lease: WindowsAclLease;
    try { lease = await (prepared ??= (prepareLease ?? initialise)()); }
    catch (cause) {
      // This session owns one preparation result. Repeating a command cannot
      // repair its failed broker or unresolved compensation.
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new ShellIsolationError(cause instanceof ShellIsolationError ? cause.code : "isolation_preparation_failed",
        `${detail}\nDo not retry shell commands in this session; fix the reported environment problem and start a new session. To explicitly use caller authority instead, start a new run with --shell-isolation host; tool approval still applies and no automatic fallback was run.`, { cause });
    }
    if (closing) throw new ShellIsolationError("isolation_closed", "command was not run");
    for (const program of [pinned[0] ?? "", ...readablePrograms]) lease.readExecutable(program);
    const command: string[] = [lease.helperPath, DISPATCH_ARG, "exec", "--quiet"];
    // Protect executable/configuration surfaces even inside the write grant.
    command.push("--deny-write", join(workspaceRoot, ".git/config"));
    for (const path of [".git/hooks", ".trylo", ".agents", ".codex"]) command.push("--deny-write", join(workspaceRoot, path) + sep);
    for (const [key, value] of Object.entries(childEnvironment({ env: hostEnvironment }))) {
      if (!["HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR"].includes(key.toUpperCase())) command.push("--env", `${key}=${value}`);
    }
    command.push("--", ...pinned);
    return command;
  };
  return {
    wrap,
    async wrapPipeSession(argv: readonly string[]): Promise<readonly string[]> {
      const pinned = pinExecutable(argv);
      // Prepare the existing broker/cache owner before publishing its sibling bundle.
      await wrap(pinned);
      stdinBridge ??= publishStdinBridge(hostEnvironment, [workspaceRoot]);
      const broker = await wrap([hostNodeExecutable(), "--preserve-symlinks", "--preserve-symlinks-main", stdinBridge.client, JSON.stringify(pinned)], [stdinBridge.packageMetadata, stdinBridge.client, pinned[0] ?? ""]);
      return [hostNodeExecutable(), stdinBridge.host, JSON.stringify(broker)];
    },
    helperEnvironment: () => windowsHelperEnvironment(hostEnvironment),
    spawner(spawn: ShellSpawner): ShellSpawner {
      return async (spec: ShellSpawnSpec) => {
        if (spec.signal.aborted) return { stdout: "", stderr: "", exitCode: -1, timedOut: false, aborted: true, truncated: false };
        const stages: readonly CommandShape[] = [spec.shape ?? { kind: "direct", argv: spec.argv }, ...(spec.pipeTo ?? []).map(segment => segment.shape)];
        let argv: readonly string[];
        if (stages.length === 1 && stages[0]?.kind !== "shell") argv = await wrap(spec.shape?.argv ?? spec.argv);
        else {
          // SRT's broker stdin carries RunnerCmd, not user pipe bytes. Run the
          // admitted stages inside one Job so their pipes never cross that IPC.
          // A single batch script needs the same runner: SRT's ordinary argv
          // quoting would escape the command line cmd must receive verbatim.
          const pinned = stages.map(stage => ({ ...stage, argv: pinExecutable(stage.argv) }));
          const runner = fileURLToPath(new URL("../../../cmd/trylo/windows-pipeline.js", import.meta.url));
          const packageMetadata = fileURLToPath(new URL("../../../../package.json", import.meta.url));
          // Node otherwise lstats every private host-profile ancestor while
          // resolving modules. Read only this installed package; never grant
          // access to the host profile or Temp parent to satisfy that lookup.
          argv = await wrap([hostNodeExecutable(), "--preserve-symlinks", "--preserve-symlinks-main", runner, JSON.stringify(pinned)], [packageMetadata, ...pinned.map(stage => stage.argv[0] ?? "")]);
        }
        if (spec.signal.aborted) return { stdout: "", stderr: "", exitCode: -1, timedOut: false, aborted: true, truncated: false };
        return await spawn({ ...spec, argv, shape: { kind: "direct", argv }, pipeTo: [] });
      };
    },
    async close(): Promise<void> {
      closing = true;
      if (prepared === undefined) return;
      // A failed initialisation already revoked its partial grant and must stay failed.
      // The failed launch already reports the initialisation error; it never acquired a usable lease.
      const lease = await prepared.catch(error => {
        if (error instanceof AggregateError) throw error;
        return undefined;
      });
      if (lease === undefined) return;
      lease.close();
    },
  };
}
