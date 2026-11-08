import { err, ok } from "../../../../../../../tooling/contract/result.js";
import { anchorUpstream } from "./anchor.js";
import { isRecord, textOf, type PlatformAdapter } from "./types.js";

/**
 * PyPI 适配器。
 *
 * 这里有两处**如实说不做**，都写在这里而不是含糊过去：
 *
 *  - **没有 JSON 检索。** PyPI 关掉了 XML-RPC 检索，官方站内搜索是 HTML。所以
 *    `searchUrl` 返回 `search_unsupported`，而不是去抓一个 HTML 页面再解析——那
 *    既脆又不该由这一层干。PyPI 的候选要走**确切包名**：`metadataUrl` 与
 *    `readMetadata` 都正常可用。
 *  - **归档地址不是公式。** PyPI 的下载地址带哈希路径（`files.pythonhosted.org/
 *     packages/<hash>/…`），只能从发布元数据的 `urls[].url` 里读。所以这里返回
 *    `not_derivable`，而不是拼一个看起来像的 URL。调用方拿到 `urls[]` 之后，把
 *    那些地址交给 `guardedGet` 取字节——它们的域（`files.pythonhosted.org`）本来
 *    就在白名单里，所以那条路是通的。
 *
 * 两处都不是缺陷，是「不假装有能力」。假装能搜、能拼 URL 的代价是下面每一层都
 * 要为一个不存在的保证写代码。
 */

const API = "https://pypi.org";
const SOURCE_HOST = "https://pypi.org";

export const PYPI: PlatformAdapter = {
  platform: "pypi",

  searchUrl: () =>
    err("search_unsupported", "PyPI has no JSON search endpoint; address packages by exact name"),

  metadataUrl: (ref) => ok(`${API}/pypi/${encodeURIComponent(ref.id)}/json`),

  archiveUrl: () =>
    err("not_derivable", "PyPI file urls come from the release metadata, not from a formula"),

  readSearch: () =>
    err("search_unsupported", "PyPI has no JSON search endpoint; address packages by exact name"),

  readMetadata: (ref, payload) => {
    if (!isRecord(payload)) {
      return err("malformed_metadata", "pypi release answer is not an object");
    }

    const info = isRecord(payload["info"]) ? payload["info"] : undefined;
    const sourceUrl = `${SOURCE_HOST}/project/${ref.id}/`;
    const declared = info === undefined ? undefined : declaredUpstreamOf(info);
    const upstream = declared === undefined ? anchorUpstream(SOURCE_HOST) : anchorUpstream(declared);
    if (!upstream.ok) {
      return upstream;
    }

    const license = info === undefined ? undefined : textOf(info["license"]);

    return ok({
      ref,
      sourceUrl,
      upstreamUrl: upstream.value,
      licenseSpdx: license ?? "UNKNOWN",
      officialIdentity: "unverified",
    });
  },
};

/** `project_urls` 里挑一个仓库地址；挑不到再看 `home_page`。键名按官方常用排序。 */
function declaredUpstreamOf(info: Record<string, unknown>): string | undefined {
  const urls = isRecord(info["project_urls"]) ? info["project_urls"] : undefined;
  if (urls !== undefined) {
    for (const key of ["Source", "Source Code", "Repository", "Code", "Homepage"]) {
      const value = textOf(urls[key]);
      if (value !== undefined) {
        return value;
      }
    }
  }

  return textOf(info["home_page"]);
}
