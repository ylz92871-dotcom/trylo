/** PID liveness is conservative under PID reuse: a live replacement is unknown work, never permission to recover. */
export function createCheckerProcessOwner(options: { readonly pid?: number; readonly probe?: (pid: number, signal: number) => unknown } = {}) {
  const pid = options.pid ?? process.pid;
  const probe = options.probe ?? process.kill;

  return { id: `checker-process:${pid}`,
    async alive(ownerId: string): Promise<"alive" | "dead" | "unknown"> {
      const match = /^checker-process:(\d+)$/u.exec(ownerId);
      if (match === null) return "unknown";
      try {
        probe(Number(match[1]), 0);
        return "alive";
      }
      catch (error) {
        return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH" ? "dead" : "unknown";
      }
    },
  };
}
