/** Explicit handback from a domain before execution. It carries no success,
 * dispatch receipt or authority to retry an uncertain external action. */
export class CentralRuntimeBlocked extends Error {
  constructor(readonly reason: string, readonly sourceRefs: readonly string[],
    readonly boundary: "preparation" | "resources" | "dependency") {
    super(reason);
    this.name = "CentralRuntimeBlocked";
  }
}
