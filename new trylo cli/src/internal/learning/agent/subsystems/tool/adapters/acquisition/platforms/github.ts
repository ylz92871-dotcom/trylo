import { err, ok } from "../../../../../../../tooling/contract/result.js";
import { anchorUpstream } from "./anchor.js";
import { isRecord, textOf, type PlatformAdapter } from "./types.js";

/**
 * GitHub 适配器。
 *
 * 检索走 `api.github.com/search/repositories`，元数据走 `/repos/<owner>/<name>`，
 * 归档走 `codeload`（GitHub 的归档主机，与 API 主机不同——所以白名单里两扇门
 * 是分开的两张表）。
 *
 * `per_page` 由我们设成常量，且用 `searchParams.set` 拼检索词——于是调用方
 * **没法**通过检索词注入第二个 `per_page`。一条小小的注入面，顺手关掉。
 */

const API = "https://api.github.com";
const ARCHIVE = "https://codeload.github.com";
const SEARCH_LIMIT = 5;

export const GITHUB: PlatformAdapter = {
  platform: "github",

  searchUrl: (capability) => {
    const url = new URL(`${API}/search/repositories`);
    url.searchParams.set("q", capability);
    url.searchParams.set("per_page", String(SEARCH_LIMIT));
    return ok(url.toString());
  },

  metadataUrl: (ref) => ok(`${API}/repos/${ref.id}`),

  archiveUrl: (ref) => ok(`${ARCHIVE}/${ref.id}/tar.gz/${ref.version ?? "HEAD"}`),

  readSearch: (payload) => {
    if (!isRecord(payload)) {
      return err("malformed_metadata", "github search answer is not an object");
    }

    const items = payload["items"];
    if (!Array.isArray(items)) {
      return err("malformed_metadata", "github search answer has no items array");
    }

    const refs = [];

    for (const item of items) {
      if (!isRecord(item)) {
        continue;
      }

      const fullName = textOf(item["full_name"]);
      if (fullName !== undefined) {
        refs.push({ platform: "github" as const, id: fullName });
      }
    }

    return ok(refs);
  },

  readMetadata: (ref, payload) => {
    if (!isRecord(payload)) {
      return err("malformed_metadata", "github repo answer is not an object");
    }

    const declared = textOf(payload["html_url"]) ?? `https://github.com/${ref.id}`;
    const source = anchorUpstream(declared);
    if (!source.ok) {
      return source;
    }

    const upstream = anchorUpstream(`https://github.com/${ref.id}`);
    if (!upstream.ok) {
      return upstream;
    }

    const license = isRecord(payload["license"]) ? textOf(payload["license"]["spdx_id"]) : undefined;
    const owner = isRecord(payload["owner"]) ? textOf(payload["owner"]["type"]) : undefined;

    return ok({
      ref,
      sourceUrl: source.value,
      upstreamUrl: upstream.value,
      licenseSpdx: license ?? "UNKNOWN",
      officialIdentity: payload["fork"] === true ? "unverified" : owner === "Organization" ? "official" : "unverified",
    });
  },
};
