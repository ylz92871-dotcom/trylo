import { err, ok, type Result } from "../../tooling/contract/result.js";
import { MAX_JSON_BYTES, guardedGet, type AcquisitionFailure } from "./guarded-get.js";
import type { HttpTransport } from "./transport.js";

/**
 * 取一份 JSON 元数据。
 *
 * 薄到几乎没有内容，这是刻意的：所有判断（域、跳数、大小、超时）都在 `guardedGet`
 * 里，这里只剩「解析」这一件与网络无关的事。于是「本层能对外做的唯一动作」仍然
 * 只有一个入口，而它是被用例钉住的那一个。
 *
 * 解析失败**不**退回部分结果：半份元数据比没有元数据更危险，因为下游会把
 * `licenseSpdx: undefined` 读成「没有限制」。
 */
export async function fetchJson(
  transport: HttpTransport,
  url: string,
  signal?: AbortSignal,
): Promise<Result<unknown, AcquisitionFailure>> {
  const response = await guardedGet(transport, url, MAX_JSON_BYTES, signal);
  if (!response.ok) {
    return response;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(response.value.body);
  } catch {
    return err("not_json", `${url} did not answer with decodable text`);
  }
  try {
    return ok(JSON.parse(text) as unknown);
  } catch {
    return err("not_json", `${url} did not answer with JSON`);
  }
}
