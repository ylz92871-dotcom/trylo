import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { SESSION_FORMAT_VERSION, type SessionPort } from "../../ports/session.js";

/** Keep private review execution in the existing canonical journal. The first
 * turn_start supplies the real mounted catalog hash; no guessed fingerprint,
 * second event schema, automatic retry or normal-task learning nomination. */
export function createHermesShadowSession(input: {
  readonly path: string; readonly sessionId: string; readonly turnId: string;
  readonly createdAt: string; readonly providerId: string; readonly model: string;
  readonly workspaceId: string; readonly workspaceRoot: string;
}): SessionPort {
  const store = createNdjsonSessionStore({ path: input.path });
  let opening: ReturnType<SessionPort["start"]> | undefined;

  return {
    ...store,

    async append(record) {
      if (record.sessionId !== input.sessionId || record.turnId !== input.turnId) {
        return { ok: false, code: "shadow_session_identity_mismatch" };
      }

      if (opening === undefined) {
        if (record.type !== "turn_start" || typeof record.payload.toolCatalogHash !== "string") {
          return { ok: false, code: "shadow_session_start_missing" };
        }
        opening = store.start({ sessionId: input.sessionId, createdAt: input.createdAt,
          fingerprint: { schemaVersion: SESSION_FORMAT_VERSION, providerId: input.providerId,
            model: input.model, toolCatalogHash: record.payload.toolCatalogHash,
            workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot } });
      }

      const opened = await opening;

      return opened.ok ? store.append(record) : opened;
    },
  };
}
