import { err, ok } from "../../../../../../../tooling/contract/result.js";
import { anchorUpstream } from "./anchor.js";
import { isRecord, textOf, type PlatformAdapter } from "./types.js";

/**
 * npm 适配器。
 *
 * 检索走官方搜索端点，精确元数据走 `/<name>/<version>`，归档走 `/<name>/-/<name>-<version>.tgz`
 * （npm 的 tarball 命名规则，scoped 包去掉 scope）。
 *
 * 一条真实约束：npm 的**下载地址要求精确版本**。没有版本就没有 tarball 名，
 * 所以 `archiveUrl` 在这里是错误而不是「猜一个 latest」——猜错版本会把一个未经
 * 评估的字节当成本次评估的对象。
 *
 * npm 包声明 GitHub 上游是常态，所以锚定只要求「在白名单内」，不要求「与本平台
 * 同域」。
 */

const REGISTRY = "https://registry.npmjs.org";
const SEARCH_LIMIT = 5;

function tarballName(id: string, version: string): string {
  const bare = id.startsWith("@") ? id.slice(id.indexOf("/") + 1) : id;
  return `${bare}-${version}.tgz`;
}

export const NPM: PlatformAdapter = {
  platform: "npm",

  searchUrl: (capability) => {
    const url = new URL(`${REGISTRY}/-/v1/search`);
    url.searchParams.set("text", capability);
    url.searchParams.set("size", String(SEARCH_LIMIT));
    return ok(url.toString());
  },

  metadataUrl: (ref) => ok(`${REGISTRY}/${encodeURIComponent(ref.id)}${ref.version === undefined ? "" : `/${encodeURIComponent(ref.version)}`}`),

  archiveUrl: (ref) =>
    ref.version === undefined
      ? err("not_derivable", "an npm tarball url needs an exact version")
      : ok(`${REGISTRY}/${encodeURIComponent(ref.id)}/-/${tarballName(ref.id, ref.version)}`),

  readSearch: (payload) => {
    if (!isRecord(payload)) {
      return err("malformed_metadata", "npm search answer is not an object");
    }

    const objects = payload["objects"];
    if (!Array.isArray(objects)) {
      return err("malformed_metadata", "npm search answer has no objects array");
    }

    const refs = [];

    for (const entry of objects) {
      const pkg = isRecord(entry) && isRecord(entry["package"]) ? entry["package"] : undefined;
      const name = pkg === undefined ? undefined : textOf(pkg["name"]);
      if (name !== undefined) {
        const version = pkg === undefined ? undefined : textOf(pkg["version"]);
        refs.push({ platform: "npm" as const, id: name, ...(version === undefined ? {} : { version }) });
      }
    }

    return ok(refs);
  },

  readMetadata: (ref, payload) => {
    if (!isRecord(payload)) {
      return err("malformed_metadata", "npm package answer is not an object");
    }

    const tags = isRecord(payload["dist-tags"]) ? payload["dist-tags"] : undefined;
    const versions = isRecord(payload["versions"]) ? payload["versions"] : undefined;
    const version = ref.version ?? (tags === undefined ? undefined : textOf(tags["latest"]))
      ?? (versions === undefined ? textOf(payload["version"]) : undefined);
    const selected = version === undefined || versions === undefined ? undefined : versions[version];
    if (version !== undefined && versions !== undefined && !isRecord(selected)) return err("malformed_metadata", "npm exact version is absent from registry metadata");

    const metadata = isRecord(selected) ? selected : payload;
    if (version !== undefined && (metadata["name"] !== ref.id || metadata["version"] !== version)) {
      return err("malformed_metadata", "npm registry identity does not match the exact requested version");
    }

    const repository = isRecord(metadata["repository"]) ? metadata["repository"] : undefined;
    const declared = typeof metadata["repository"] === "string" ? textOf(metadata["repository"])
      : repository === undefined ? undefined : textOf(repository["url"]);
    const sourceUrl = `https://www.npmjs.com/package/${ref.id}`;
    const upstream = anchorUpstream(declared ?? `${REGISTRY}/${encodeURIComponent(ref.id)}`);
    if (!upstream.ok) {
      return upstream;
    }

    if (version === undefined) return err("malformed_metadata", "npm registry metadata did not establish an exact package version");

    const license = textOf(metadata["license"]);

    return ok({
      ref: { ...ref, ...(version === undefined ? {} : { version }) },
      sourceUrl,
      upstreamUrl: upstream.value,
      licenseSpdx: license ?? "UNKNOWN",
      // npm 不告诉我们「谁算官方」；我们不替它猜，所以永远是 unverified。
      officialIdentity: "unverified",
    });
  },
};
