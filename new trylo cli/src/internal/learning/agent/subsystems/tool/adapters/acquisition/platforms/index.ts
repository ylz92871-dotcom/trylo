import type { Platform } from "../allowlist.js";
import { GITHUB } from "./github.js";
import { MCP_REGISTRY } from "./mcp-registry.js";
import { NPM } from "./npm.js";
import { PYPI } from "./pypi.js";
import type { PlatformAdapter } from "./types.js";

export { anchorUpstream } from "./anchor.js";
export { GITHUB } from "./github.js";
export { MCP_REGISTRY } from "./mcp-registry.js";
export { NPM } from "./npm.js";
export { PYPI } from "./pypi.js";
export {
  isRecord,
  textOf,
  type CandidateMetadata,
  type CandidateRef,
  type PlatformAdapter,
} from "./types.js";

/**
 * 四个平台各一个，一个都不多。
 *
 * 这张表与白名单是同一件事的两面：白名单说「能跟谁说话」，这张表说「跟它说话要
 * 用哪种口音」。加第五个平台要同时动白名单与这里——两处都要动，正是它该有的样子。
 */
export const PLATFORM_ADAPTERS: readonly PlatformAdapter[] = [GITHUB, NPM, PYPI, MCP_REGISTRY];

export function adapterOf(platform: Platform): PlatformAdapter | undefined {
  return PLATFORM_ADAPTERS.find((adapter) => adapter.platform === platform);
}
