import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ARCHIVE_BYTES,
  MAX_JSON_BYTES,
  MAX_REDIRECTS,
  REQUEST_TIMEOUT_MS,
  guardedGet,
} from "./guarded-get.js";
import { fetchArchive } from "./fetch-archive.js";
import { fetchJson } from "./fetch-json.js";
import { ALLOWED_HOSTS, PLATFORM_DOORS, allowedHosts, isAllowedHost, platformOf } from "./allowlist.js";
import type {
  HttpTransport,
  HttpTransportRequest,
  HttpTransportResponse,
  TransportFailure,
} from "./transport.js";
import { err, ok, type Result } from "../../../../../../tooling/contract/result.js";

/**
 * 候选获取层的闸（P05 工具学习规格 §3 + §4）。
 *
 * 这一层是全局唯一能对外说话的地方，所以它的规则必须少而硬：**先查域，再说话；
 * 每一跳都查；说不清就不要字节。** 出站白名单是硬编码常量而不是配置，因为一个
 * 可被改写的白名单等于没有白名单。
 *
 * 全部用例走注入的假 transport——没有一条真的联网。这既是测试纪律，也是「本层
 * 能做的唯一对外动作被一个可替换的口收拢」的证明。
 */

type Scripted = {
  readonly status: number;
  readonly location?: string;
  readonly body?: string;
};

/** 按 URL 顺序回答的假 transport，并记录每一次它被问到的 URL。 */
function scriptedTransport(script: ReadonlyArray<Scripted>): {
  readonly transport: HttpTransport;
  readonly asked: string[];
  readonly limits: HttpTransportRequest[];
} {
  const asked: string[] = [];
  const limits: HttpTransportRequest[] = [];
  let index = 0;
  const transport: HttpTransport = {
    get: async (request): Promise<Result<HttpTransportResponse, TransportFailure>> => {
      asked.push(request.url);
      limits.push(request);
      const step = script[index];

      index += 1;

      if (step === undefined) {
        return err("network_failure", "script exhausted");
      }

      return ok({
        status: step.status,
        ...(step.location === undefined ? {} : { location: step.location }),
        body: new TextEncoder().encode(step.body ?? ""),
      });
    },
  };

  return { transport, asked, limits };
}

const GITHUB_API = "https://api.github.com/repos/o/r/licenses";

test("K1 白名单是硬编码常量，且等于四个平台门声明的主机全集（最小授权）", () => {
  const declared = new Set<string>();

  for (const door of PLATFORM_DOORS) {
    for (const host of [...door.apiHosts, ...door.downloadHosts]) {
      declared.add(host);
    }
  }

  assert.deepEqual([...ALLOWED_HOSTS].sort(), [...declared].sort());
  // 多一个 = 过度授权；少一个 = 门在误报。上面这条等式同时挡住两种。
  assert.deepEqual([...allowedHosts()].sort(), [...declared].sort());
  assert.equal(PLATFORM_DOORS.length, 4);
});

test("K2 非白名单域一律拒（先查域，再说话）", async () => {
  const { transport, asked } = scriptedTransport([{ status: 200, body: "{}" }]);
  const result = await guardedGet(transport, "https://evil.example.com/x", MAX_JSON_BYTES);

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.code, "host_not_allowed");
  }

  assert.deepEqual(asked, [], "被拒的请求连发都不许发出去");
});

test("K3 明文 http 一律拒（白名单只锚 https）", async () => {
  const { transport, asked } = scriptedTransport([{ status: 200, body: "{}" }]);
  const result = await guardedGet(transport, "http://api.github.com/x", MAX_JSON_BYTES);

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.code, "insecure_scheme");
  }

  assert.deepEqual(asked, []);
});

test("K4 重定向到白名单外 → 拒；每一跳都要重新查域", async () => {
  const { transport, asked } = scriptedTransport([
    { status: 302, location: "https://evil.example.com/steal" },
  ]);
  const result = await guardedGet(transport, GITHUB_API, MAX_JSON_BYTES);

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.code, "host_not_allowed");
  }

  assert.deepEqual(asked, [GITHUB_API], "第二跳必须在校验之后才发，不能被跟随");
});

test("K5 白名单内的重定向可以跟随，且逐跳累计", async () => {
  const { transport, asked } = scriptedTransport([
    { status: 301, location: "https://codeload.github.com/archive.tar.gz" },
    { status: 200, body: "payload" },
  ]);
  const result = await guardedGet(transport, GITHUB_API, MAX_JSON_BYTES);

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  assert.equal(result.value.redirects, 1);
  assert.equal(result.value.url, "https://codeload.github.com/archive.tar.gz");
  assert.deepEqual(asked, [GITHUB_API, "https://codeload.github.com/archive.tar.gz"]);
});

test("K6 重定向次数超上限 → 拒（不许被一个环拖死）", async () => {
  const loop: Scripted[] = Array.from({ length: MAX_REDIRECTS + 2 }, () => ({
    status: 302,
    location: GITHUB_API,
  }));
  const { transport } = scriptedTransport(loop);
  const result = await guardedGet(transport, GITHUB_API, MAX_JSON_BYTES);

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.code, "too_many_redirects");
  }
});

test("K7 超过大小上限 → 拒（上限随请求下发，不是事后才发现）", async () => {
  const { transport, limits } = scriptedTransport([{ status: 200, body: "x".repeat(64) }]);
  const result = await guardedGet(transport, GITHUB_API, 8);

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.code, "too_large");
  }

  assert.equal(limits[0]?.maxBytes, 8);
  assert.equal(limits[0]?.timeoutMs, REQUEST_TIMEOUT_MS);
});

test("K8 JSON 取回来就直接可用；不是 JSON 就拒", async () => {
  const good = scriptedTransport([{ status: 200, body: '{"license":{"spdx_id":"MIT"}}' }]);
  const parsed = await fetchJson(good.transport, GITHUB_API);

  assert.equal(parsed.ok, true);

  if (parsed.ok) {
    assert.deepEqual(parsed.value, { license: { spdx_id: "MIT" } });
  }

  const bad = scriptedTransport([{ status: 200, body: "<html>nope" }]);
  const refused = await fetchJson(bad.transport, GITHUB_API);

  assert.equal(refused.ok, false);

  if (!refused.ok) {
    assert.equal(refused.code, "not_json");
  }
});

test("K9 归档取出的是字节加哈希，本层不给任何写入路径", async () => {
  const { transport } = scriptedTransport([{ status: 200, body: "tarball-bytes" }]);
  const result = await fetchArchive(transport, "https://codeload.github.com/o/r/tar.gz/v1");

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  assert.equal(result.value.bytes, "tarball-bytes".length);
  assert.match(result.value.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.value.body.length, "tarball-bytes".length);
  assert.equal(JSON.stringify(Object.keys(result.value)), JSON.stringify(["url", "sha256", "bytes", "body"]));
});

test("K10 归档的大小上限比 JSON 宽得多，但不是无上限", () => {
  assert.equal(MAX_JSON_BYTES < MAX_ARCHIVE_BYTES, true);
  assert.equal(MAX_ARCHIVE_BYTES > 0 && Number.isFinite(MAX_ARCHIVE_BYTES), true);
});

test("K11 平台归属反查：每个白名单主机都能说清自己是谁家的", () => {
  for (const host of ALLOWED_HOSTS) {
    assert.notEqual(platformOf(host), undefined, `${host} 必须归属某个平台`);
    assert.equal(isAllowedHost(host), true);
  }

  assert.equal(platformOf("api.github.com"), "github");
  assert.equal(platformOf("registry.npmjs.org"), "npm");
  assert.equal(platformOf("evil.example.com"), undefined);
});

test("K12 http 非 2xx 一律拒（把状态码原样带出去，不猜）", async () => {
  const { transport } = scriptedTransport([{ status: 503, body: "busy" }]);
  const result = await guardedGet(transport, GITHUB_API, MAX_JSON_BYTES);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "http_error");
  }
});
