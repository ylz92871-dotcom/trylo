import assert from "node:assert/strict";
import test from "node:test";
import { GITHUB } from "./github.js";
import { NPM } from "./npm.js";
import { PYPI } from "./pypi.js";
import { MCP_REGISTRY } from "./mcp-registry.js";
import { PLATFORM_ADAPTERS, adapterOf } from "./index.js";
import { isAllowedHost, platformOf } from "../allowlist.js";
import type { PlatformAdapter } from "./types.js";

/**
 * 四个平台薄适配器（规格 §3）。
 *
 * 每个适配器只做三件事：拼检索 URL、拼元数据 URL、把平台自己的 JSON 读成我们的
 * 形状。**它们不取字节**——取字节是 `guardedGet` 的事，而那是唯一会查白名单的
 * 地方。分开的理由很实际：适配器要改的只是 URL 与字段名，闸门一个都不该跟着动。
 *
 * 域名锚定（规格 §4 唯一新增的一条）落在 `readMetadata` 里：元数据里声明的上游
 * 仓库必须落在白名单域内，否则这个候选连进评估的资格都没有。
 */

function urlsOf(adapter: PlatformAdapter): string[] {
  const ref = { platform: adapter.platform, id: "example/thing", version: "1.0.0" } as const;
  const out: string[] = [];
  const search = adapter.searchUrl("pdf tables");
  if (search.ok) {
    out.push(search.value);
  }

  const meta = adapter.metadataUrl(ref);
  if (meta.ok) {
    out.push(meta.value);
  }

  const archive = adapter.archiveUrl(ref);
  if (archive.ok) {
    out.push(archive.value);
  }

  return out;
}

test("L1 每个适配器拼出的 URL 的主机都在白名单内，且归属自己那个平台", () => {
  for (const adapter of PLATFORM_ADAPTERS) {
    const urls = urlsOf(adapter);

    assert.equal(urls.length > 0, true, `${adapter.platform} 至少要能拼出一个 URL`);

    for (const raw of urls) {
      const host = new URL(raw).host;
      assert.equal(isAllowedHost(host), true, `${adapter.platform} 拼出了白名单外的 ${host}`);
      assert.notEqual(platformOf(host), undefined);
    }
  }
});

test("L2 检索词被编码，且不允许把 query 拼成第二个参数", () => {
  const search = GITHUB.searchUrl("a&per_page=999");

  assert.equal(search.ok, true);

  if (!search.ok) {
    return;
  }

  const url = new URL(search.value);

  assert.equal(url.searchParams.get("per_page"), "5", "注入的 per_page 不许生效");
  assert.equal(url.searchParams.get("q"), "a&per_page=999");
});

test("L3 PyPI 的两处「不做」都如实说不做，而不是假装能做到", () => {
  // 检索：PyPI 关掉了 JSON 检索，官方站内搜索是 HTML。抓 HTML 再解析既脆又不该
  // 由这一层干，所以如实拒绝。
  const search = PYPI.searchUrl("pdf tables");

  assert.equal(search.ok, false);

  if (!search.ok) {
    assert.equal(search.code, "search_unsupported");
  }

  // 归档：PyPI 的下载地址带哈希路径，只能从发布元数据里读，不是公式。
  const archive = PYPI.archiveUrl({ platform: "pypi", id: "pdfplumber", version: "0.11.0" });

  assert.equal(archive.ok, false);

  if (!archive.ok) {
    assert.equal(archive.code, "not_derivable");
  }

  // 但按确切名字取元数据是成立的——这正是 PyPI 那条路的样子。
  const meta = PYPI.metadataUrl({ platform: "pypi", id: "pdfplumber" });

  assert.equal(meta.ok, true);
});

test("L4 元数据读取：白名单内的上游被接受，形状归一", () => {
  const read = GITHUB.readMetadata(
    { platform: "github", id: "o/r" },
    {
      html_url: "https://github.com/o/r",
      license: { spdx_id: "MIT" },
      owner: { type: "Organization" },
      fork: false,
    },
  );

  assert.equal(read.ok, true);

  if (!read.ok) {
    return;
  }

  assert.equal(read.value.sourceUrl, "https://github.com/o/r");
  assert.equal(read.value.licenseSpdx, "MIT");
  assert.equal(read.value.officialIdentity, "official");
});

test("L5 域名锚定：元数据声称的上游在白名单外 → 拒（防元数据投毒）", () => {
  const read = NPM.readMetadata(
    { platform: "npm", id: "left-pad" },
    { repository: { url: "https://evil.example.com/o/r.git" }, license: "MIT" },
  );

  assert.equal(read.ok, false);

  if (!read.ok) {
    assert.equal(read.code, "domain_mismatch");
  }
});

test("L6 npm 包声明 GitHub 上游是正常的（跨平台但在白名单内）", () => {
  const read = NPM.readMetadata(
    { platform: "npm", id: "left-pad", version: "1.0.0" },
    { name: "left-pad", version: "1.0.0", repository: { url: "git+https://github.com/o/r.git" }, license: "MIT" },
  );

  assert.equal(read.ok, true);

  if (!read.ok) {
    return;
  }

  assert.equal(new URL(read.value.upstreamUrl).host, "github.com");
  assert.equal(read.value.licenseSpdx, "MIT");
});

test("L7 读不出来的字段降级成 UNKNOWN，而不是编一个许可证", () => {
  const read = MCP_REGISTRY.readMetadata(
    { platform: "mcp_registry", id: "io.example/thing" },
    { server: { name: "io.example/thing" } },
  );

  assert.equal(read.ok, true);

  if (!read.ok) {
    return;
  }

  assert.equal(read.value.licenseSpdx, "UNKNOWN");
  assert.equal(read.value.officialIdentity, "unverified");
});

test("L8 平台归属可反查，且四个平台各有一个适配器（不许有第五个）", () => {
  assert.equal(PLATFORM_ADAPTERS.length, 4);
  for (const adapter of PLATFORM_ADAPTERS) {
    assert.equal(adapterOf(adapter.platform), adapter);
  }
  assert.equal(adapterOf("github"), GITHUB);
  assert.equal(adapterOf("mcp_registry"), MCP_REGISTRY);
});
