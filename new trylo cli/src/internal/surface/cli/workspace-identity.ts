import { createHash } from "node:crypto";

/** Durable native identity. Existing journals and assets retain this exact hash. */
export function workspaceIdentity(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
}
