import { err, ok, type Result } from "../../tooling/contract/result.js";
import { isAllowedHost } from "./allowlist.js";
import type { HttpTransport } from "./transport.js";

/**
 * 闸门：**先查域，再说话；每一跳都查；说不清就不要字节。**
 *
 * 这一层是白名单的唯一执行处。三件事都必须在**发请求之前**决定，理由很朴素：
 * 一次已经发出去的请求收不回来，而「下载了一个不该下的东西」不是能回滚的错误。
 *
 *  - **只锚 https。** 明文 http 的白名单是自欺欺人：路径上任何一跳都能改内容。
 *  - **每一跳重新查域。** 这是最容易被漏掉的一条。只查首个 URL 的白名单等于没有
 *    白名单——任何一个被允许的主机都能用一次 302 把请求引到任意地方。所以
 *    `Location` 先解析、先查域，**通过了才发**。
 *  - **上限随请求下发。** `maxBytes` 交给 transport，让它在读的过程中刹车；读完
 *    再判大小意味着攻击者可以先用内存把进程压死。
 */

export const MAX_REDIRECTS = 3;
export const MAX_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 15_000;

/** 对外自报身份：不伪装成浏览器，出问题时有个人话可以查。 */
export const USER_AGENT = "trylo-tool-acquisition/1.0 (+local)";

export type AcquisitionFailure =
  | "cancelled"
  | "insecure_scheme"
  | "host_not_allowed"
  | "too_many_redirects"
  | "http_error"
  | "too_large"
  | "timeout"
  | "network_failure"
  | "not_json"
  | "malformed_metadata"
  | "domain_mismatch"
  | "search_unsupported"
  | "not_derivable";

export type GuardedResponse = {
  /** 最后一跳的 URL（可能是重定向之后的那一个）。 */
  readonly url: string;
  readonly body: Uint8Array;
  readonly redirects: number;
};

export async function guardedGet(
  transport: HttpTransport,
  url: string,
  limitBytes: number,
  signal?: AbortSignal,
): Promise<Result<GuardedResponse, AcquisitionFailure>> {
  let current = url;
  for (let redirects = 0; ; redirects += 1) {
    if (signal?.aborted) return err("cancelled", "tool acquisition was cancelled");
    if (redirects > MAX_REDIRECTS) {
      return err("too_many_redirects", `${url} redirected more than ${MAX_REDIRECTS} times`);
    }
    const allowed = allow(current);
    if (!allowed.ok) {
      return allowed;
    }
    const response = await transport.get({
      url: current,
      headers: { accept: "application/json, application/octet-stream", "user-agent": USER_AGENT },
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: limitBytes,
      ...(signal === undefined ? {} : { signal }),
    });
    if (signal?.aborted) return err("cancelled", "tool acquisition was cancelled");
    if (!response.ok) {
      return err(response.code, response.message);
    }
    const value = response.value;
    if (value.status >= 300 && value.status < 400) {
      if (value.location === undefined) {
        return err("http_error", `${current} answered ${value.status} without a location`);
      }
      current = new URL(value.location, current).toString();
      continue;
    }
    if (value.status < 200 || value.status >= 300) {
      return err("http_error", `${current} answered ${value.status}`);
    }
    // 上限查两遍：一遍委托给 transport（让它边读边刹车，而不是读完才发现），
    // 一遍在这里复核。第二遍不是因为不信 transport，而是因为**上限是一道闸**，
    // 而闸门不该只存在于被调用方。一个写错的 transport 就能把 1GB 直接送进来。
    if (value.body.length > limitBytes) {
      return err("too_large", `${current} answered ${value.body.length} bytes over the ${limitBytes} byte cap`);
    }
    return ok({ url: current, body: value.body, redirects });
  }
}

/**
 * 一个 URL 能不能被请求。
 *
 * 端口也一起核：`https://api.github.com:8443/` 的 hostname 是白名单里的，但它
 * 去的是一个完全不同的服务。默认端口之外一律拒。
 */
export function allow(raw: string): Result<URL, AcquisitionFailure> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return err("host_not_allowed", `unparseable url ${raw}`);
  }
  if (url.protocol !== "https:") {
    return err("insecure_scheme", `refusing ${url.protocol} for ${url.hostname}`);
  }
  if (url.port !== "" && url.port !== "443") {
    return err("host_not_allowed", `${url.hostname}:${url.port} is not on the outbound allowlist`);
  }
  if (!isAllowedHost(url.hostname)) {
    return err("host_not_allowed", `${url.hostname} is not on the outbound allowlist`);
  }
  return ok(url);
}
