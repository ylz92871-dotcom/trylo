import { createPermissionGrantCache, type PermissionGrantCache } from "../../loop/permission-grants.js";
import { WORKSPACE_WRITE_TOOL_NAMES } from "../../adapters/tools/mutating/bindings.js";
import { APPROVABLE_TOOL_NAMES, isApprovableToolName, type PermissionChoice } from "./permission-plan.js";
import { PATH_READ_TOOL_NAMES } from "../../adapters/tools/read-only/path-names.js";

export type PermissionMode = "read-only" | "confirm" | "auto-edit";

export type SessionPermissions = {
  readonly grants: PermissionGrantCache;
  readonly snapshot: () => {
    readonly mode: PermissionMode;
    readonly allowTools: ReadonlyArray<string>;
    readonly denyTools: ReadonlyArray<string>;
    readonly grants: ReturnType<PermissionGrantCache["entries"]>;
    readonly effectiveChoice: PermissionChoice;
  };
  readonly setMode: (mode: PermissionMode) => void;
  /** Explicitly enables a whole tool, not just one remembered command. */
  readonly allowTool: (name: string) => void;
  readonly denyTool: (name: string) => void;
  readonly revokeTool: (name: string) => void;
  readonly choice: (explicit: PermissionChoice) => PermissionChoice;
  readonly close: () => void;
};

/** One controller and canonical grant cache per opened CLI session, never persisted. */
export function createSessionPermissions(initial: PermissionChoice = {}): SessionPermissions {
  const grants = createPermissionGrantCache();
  let mode: PermissionMode = "confirm";
  let selected = false;
  const allowed = new Set<string>();
  const denied = new Set<string>();

  const forgetTool = (name: string): void => {
    for (const grant of grants.entries()) {
      if (grant.name === name) grants.revoke(grant.pattern);
    }
  };
  const choiceFor = (explicit: PermissionChoice): PermissionChoice => {
    if (Object.keys(explicit).length > 0) return explicit;
    if (!selected) return initial;
    if (mode === "read-only") return { ask: "never", denyTools: APPROVABLE_TOOL_NAMES.filter(name => !PATH_READ_TOOL_NAMES.includes(name)) };
    return {
      ask: "always",
      allowTools: [...(mode === "auto-edit" ? WORKSPACE_WRITE_TOOL_NAMES : []), ...allowed],
      denyTools: [...denied],
    };
  };
  return {
    grants,
    snapshot: () => ({ mode, allowTools: [...allowed], denyTools: [...denied], grants: grants.entries(), effectiveChoice: choiceFor({}) }),
    setMode(next) {
      mode = next;
      selected = true;
      allowed.clear();
      denied.clear();
      grants.clear();
    },
    allowTool(name) {
      if (!isApprovableToolName(name)) throw new Error(`unknown approvable tool: ${name}`);
      if (mode === "read-only") throw new Error("switch out of read-only mode before enabling a tool");
      selected = true;
      denied.delete(name);
      allowed.add(name);
      forgetTool(name);
    },
    denyTool(name) {
      selected = true;
      allowed.delete(name);
      denied.add(name);
      forgetTool(name);
    },
    revokeTool(name) {
      selected = true;
      allowed.delete(name);
      denied.delete(name);
      forgetTool(name);
    },
    choice: choiceFor,
    close() {
      grants.clear();
      allowed.clear();
      denied.clear();
    },
  };
}
