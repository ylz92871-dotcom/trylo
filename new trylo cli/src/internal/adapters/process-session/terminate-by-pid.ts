import {
  describeFailure,
  terminateProcessTree,
  terminateWindowsTree,
  type TreeKillDeps,
  type TreeTermination,
} from "./process-tree.js";
import { defaultTreeKillDeps } from "./process-tree.js";
import { identityMatches, type DaemonIdentity } from "../../domain/daemon-identity.js";
import { observeDarwinProcess } from "./darwin-process.js";

/**
 * End a process that **another** process started, given only its pid
 * (WP26 / A04: `trylo bg kill` from a second terminal).
 *
 * Its own module rather than more lines in `process-tree.ts`, because that file is
 * about a child *this* process holds and this one is about a number read off disk.
 *
 * ## win32
 *
 * `taskkill /T /F` walks by pid and needs nothing else, so the policy is **the same
 * function** the in-process path calls. A second implementation of "kill the tree"
 * is how one of them drifts.
 *
 * Darwin requires a recorded identity and a live process-group leader before
 * delegating to the same group terminator as in-process jobs.
 */
export async function terminatePidTree(
  pid: number,
  deps: TreeKillDeps = defaultTreeKillDeps(),
  recorded?: DaemonIdentity,
): Promise<TreeTermination> {
  if (deps.platform === "win32") {
    // `exitCode: null` is the honest value: nobody here waited on this process, so
    // nothing is known about an ending. The walk goes ahead, and taskkill's own
    // "no such process" exit is what turns the answer into `already_gone`.
    return await terminateWindowsTree({ pid, exitCode: null, kill: () => false }, deps);
  }
  if (deps.platform === "darwin" && recorded !== undefined && pid > 1) {
    try {
      const live = await observeDarwinProcess(pid);
      if (live === undefined || !identityMatches(recorded, live)) return { ok: true, how: "already_gone" };
      if (live.processGroup !== pid) {
        return { ok: false, code: "tree_kill_unobservable", message: describeFailure("tree_kill_unobservable", `pid ${pid} is not the recorded process group's leader`) };
      }
      return terminateProcessTree({ pid, exitCode: null, kill: () => false }, deps);
    } catch (error) {
      return { ok: false, code: "tree_kill_unobservable", message: describeFailure("tree_kill_unobservable", error instanceof Error ? error.message : String(error)) };
    }
  }
  return {
    ok: false,
    code: "tree_kill_unsupported_platform",
    message: describeFailure(
      "tree_kill_unsupported_platform",
      `platform ${deps.platform} cannot be tree-killed by pid without risking a group this process belongs to`,
    ),
  };
}
