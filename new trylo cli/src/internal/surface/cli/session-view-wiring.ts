/**
 * The process-session registries for a run, and the single view over both.
 *
 * Split out of `wiring.ts` under that file's size gate. Moved, not changed:
 * both registries are still built exactly once per wiring, so the tools that
 * observe a command and the processes they observe stay the same objects. A
 * registry constructed inside the catalog would be a second one, holding
 * sessions nothing else could reach — the catalog would advertise session
 * tools and every one of them would answer "no such session" forever.
 */

import { homedir } from "node:os";
import { createProcessSessionRegistry } from "../../adapters/process-session/session-registry.js";
import { createJobStore } from "../../adapters/process-session/job-store.js";
import { tryloHome } from "./session-paths.js";
import { createPtySessionRegistry } from "../../adapters/process-session/pty-session.js";
import { resolvePtyHelper } from "../../adapters/process-session/pty-loader.js";
import { createSessionView } from "../../adapters/process-session/session-view.js";
import type { ProcessSessionRegistry } from "../../adapters/process-session/session-registry.js";

/**
 * @param options.homeDir where a durable record is filed; a test passes its own
 *     temp home rather than the real one.
 * @param options.env read only for `TRYLO_HOME`, the same override every other
 *     durable path in the CLI honours, so `bg` looks where the run wrote.
 *
 * Both are taken as an options object with `??` defaults because that is the one
 * shape the ambient-source scan recognises as an injection seam (see
 * `session-registry.ts`'s `options.now ?? Date.now`). A parameter default would
 * read as ambient, and this file is not a sanctioned owner of `process`.
 */
export function createSessionViewForRun(
  options: {
    homeDir?: string;
    env?: Readonly<Record<string, string | undefined>>;
  } = {},
): ProcessSessionRegistry {
  const homeDir = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  // The pipes registry serves `runInBackground`; the PTY one serves interactive
  // programs that need a real terminal. They are separate because they fail
  // differently, and a caller cannot tell which it needs before it has tried.
  const pipesSessions = createProcessSessionRegistry({
    // Publishing here is what makes `trylo bg` answer to a second terminal: the
    // registry keeps owning the live session, and each start/output/ending is
    // mirrored into the durable table. Only the pipes path publishes — a PTY
    // session is an interactive terminal whose pipes this process never holds, so
    // a record for it could be read but never followed.
    jobs: createJobStore({ home: tryloHome(homeDir, env) }),
  });
  // Absent on a platform with no sidecar, which is what makes the PTY path
  // report "no sessions" rather than pretending a terminal exists.
  const ptyResolution = resolvePtyHelper();
  const ptySessions = ptyResolution.ok ? createPtySessionRegistry() : undefined;

  // One view over both, so the session tools can see a terminal session they did
  // not start. Splitting them here would reproduce the defect this wiring exists
  // to remove: a session that exists and that no tool can name.
  return createSessionView({
    pipes: pipesSessions,
    ...(ptySessions === undefined ? {} : { pty: ptySessions }),
  });
}
