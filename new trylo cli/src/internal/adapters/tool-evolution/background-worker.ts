import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

/** Only the CLI composition root supplies arguments; this is not a tool exposed to a model. */
export async function dispatchToolLearningWorker(input: {
  readonly nodeExecutable: string; readonly entrypoint: string; readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>; readonly args: readonly string[];
}): Promise<{ readonly ok: true; readonly pid: number } | { readonly ok: false; readonly code: string }> {
  if (![input.nodeExecutable, input.entrypoint, input.cwd].every(value => path.isAbsolute(value))) return { ok: false, code: "worker_paths_not_absolute" };
  return new Promise(resolve => {
    let child: ChildProcess | undefined, settled = false;
    const finish = (result: { readonly ok: true; readonly pid: number } | { readonly ok: false; readonly code: string }) => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(result);
    };
    const timer = setTimeout(() => { child?.kill(); finish({ ok: false, code: "worker_start_timeout" }); }, 5_000);
    try {
      child = spawn(input.nodeExecutable, [input.entrypoint, ...input.args], { cwd: input.cwd,
        env: Object.fromEntries(Object.entries(input.env).filter((pair): pair is [string, string] => pair[1] !== undefined)),
        detached: true, windowsHide: true, stdio: "ignore" });
      child.once("error", () => finish({ ok: false, code: "worker_spawn_failed" }));
      child.once("spawn", () => {
        if (settled) { child?.kill(); return; }
        if (child?.pid === undefined) { child?.kill(); finish({ ok: false, code: "worker_pid_unavailable" }); return; }
        child.unref(); finish({ ok: true, pid: child.pid });
      });
    } catch { finish({ ok: false, code: "worker_spawn_failed" }); }
  });
}
