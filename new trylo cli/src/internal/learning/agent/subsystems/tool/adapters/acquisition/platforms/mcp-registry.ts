import { err, ok } from "../../../../../../../tooling/contract/result.js";
import { anchorUpstream } from "./anchor.js";
import { isRecord, textOf, type PlatformAdapter } from "./types.js";

/**
 * MCP 官方 registry 适配器。
 *
 * 它只做发现与身份：检索 server 名、取它的元数据（含它自己的仓库地址与许可证）。
 * **它没有自己的归档**——一个 registry 条目指向的是一个包，而那个包住在 npm 或
 * PyPI 上。所以 `archiveUrl` 返回 `not_derivable`：正确做法是拿这个条目里的包名
 * 去对应平台的适配器取，而不是在这里拼一个不存在的地址。
 *
 * 这条边界值得写下来，因为「万物皆可插件」里最容易走歪的一步就是：把一个发现
 * 目录当成一个下载源。
 */

const REGISTRY = "https://registry.modelcontextprotocol.io";
const SEARCH_LIMIT = 5;

export const MCP_REGISTRY: PlatformAdapter = {
  platform: "mcp_registry",

  searchUrl: (capability) => {
    const url = new URL(`${REGISTRY}/v0/servers`);
    url.searchParams.set("search", capability);
    url.searchParams.set("limit", String(SEARCH_LIMIT));
    return ok(url.toString());
  },

  metadataUrl: (ref) => ok(`${REGISTRY}/v0/servers/${encodeURIComponent(ref.id)}`),

  archiveUrl: () =>
    err("not_derivable", "a registry entry points at a package; fetch it from its own platform"),

  readSearch: (payload) => {
    if (!isRecord(payload)) {
      return err("malformed_metadata", "registry answer is not an object");
    }

    const servers = payload["servers"];
    if (!Array.isArray(servers)) {
      return err("malformed_metadata", "registry answer has no servers array");
    }

    const refs = [];

    for (const entry of servers) {
      const server = isRecord(entry) && isRecord(entry["server"]) ? entry["server"] : entry;
      const name = isRecord(server) ? textOf(server["name"]) : undefined;
      if (name !== undefined) {
        refs.push({ platform: "mcp_registry" as const, id: name });
      }
    }

    return ok(refs);
  },

  readMetadata: (ref, payload) => {
    if (!isRecord(payload)) {
      return err("malformed_metadata", "registry entry is not an object");
    }

    const server = isRecord(payload["server"]) ? payload["server"] : payload;
    const declared = declaredUpstreamOf(server);
    const sourceUrl = `${REGISTRY}/v0/servers/${encodeURIComponent(ref.id)}`;
    const upstream = declared === undefined ? anchorUpstream(sourceUrl) : anchorUpstream(declared);
    if (!upstream.ok) {
      return upstream;
    }

    const license = textOf(server["license"]);

    return ok({
      ref,
      sourceUrl,
      upstreamUrl: upstream.value,
      licenseSpdx: license ?? "UNKNOWN",
      // registry 不担保「官方」；一个条目被收录不等于它被背书。
      officialIdentity: "unverified",
    });
  },
};

function declaredUpstreamOf(server: Record<string, unknown>): string | undefined {
  const repository = isRecord(server["repository"]) ? server["repository"] : undefined;
  return repository === undefined ? textOf(server["homepage"]) : textOf(repository["url"]);
}
