import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonObject } from "../protocol/envelope.js";

export type McpWorkspaceRoots = {
  readonly capabilities: JsonObject;
  readonly list: JsonObject | undefined;
};

/** Workspace context only: roots neither approve tools nor grant filesystem access.
 * Remote callers must opt in explicitly; never derive roots from a server URL or install directory.
 */
export function createWorkspaceRoots(workspaceRoot: string | undefined): McpWorkspaceRoots {
  if (workspaceRoot === undefined)
    return { capabilities: {}, list: undefined };

  if (!isAbsolute(workspaceRoot))
    throw new TypeError("MCP workspaceRoot must be an absolute path");

  return {
    capabilities: { roots: { listChanged: false } },
    list: { roots: [{ uri: pathToFileURL(workspaceRoot).href }] },
  };
}
