import type { IsolationPort } from "../../ports/isolation.js";
import { hostShellEnvironment } from "./executable.js";
import { windowsHelperEnvironment } from "./windows/windows-helper-environment.js";
import { createWindowsIsolation } from "./windows/windows-isolation.js";

/** Select OS mechanics here. Callers keep their existing permission and task state. */
export function createPlatformIsolation(
  env: Readonly<Record<string, string | undefined>>,
  platform = hostShellEnvironment().platform,
): IsolationPort {
  if (platform === "win32") return createWindowsIsolation({ hostEnv: windowsHelperEnvironment(env) });

  const reason = "OS isolation has not been integrated for " + platform;
  return {
    async probe() { return { state: "unavailable", reason }; },
    async run(request) {
      if (request.signal.aborted) return { outcome: "cancelled" };
      return { outcome: "isolation_failed", code: "isolation_unavailable", message: reason };
    },
  };
}
