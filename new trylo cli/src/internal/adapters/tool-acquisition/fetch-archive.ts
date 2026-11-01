import { createHash } from "node:crypto";
import { ok, type Result } from "../../tooling/contract/result.js";
import { MAX_ARCHIVE_BYTES, guardedGet, type AcquisitionFailure } from "./guarded-get.js";
import type { HttpTransport } from "./transport.js";

/**
 * 取一份归档的**字节**。就这一件事，没有第二件。
 *
 * 刻意不提供任何写入路径：字节留在内存里，交给调用方。收容、落盘、解包全部是
 * 别人（`quarantine` / `archive-guard`）的事，而它们的门已经先于这一包存在——
 * 「下载条目不能绕过档案审计」这条合同今天就在跑。把写入能力放在这一层，等于给
 * 攻击面开一个绕过那些门的口子，所以这一层**没有** `write`、没有路径参数、
 * 没有「存到哪」。
 *
 * 哈希在这里算，因为字节刚到手、还没被别人碰过——这是唯一一个「这份字节和这个
 * 哈希一定对应」的时刻。下游要核的是「收到的和当初说的是不是同一份」。
 */
export type FetchedArchive = {
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly body: Uint8Array;
};

export async function fetchArchive(
  transport: HttpTransport,
  url: string,
  signal?: AbortSignal,
): Promise<Result<FetchedArchive, AcquisitionFailure>> {
  const response = await guardedGet(transport, url, MAX_ARCHIVE_BYTES, signal);
  if (!response.ok) {
    return response;
  }
  const body = response.value.body;
  return ok({
    url: response.value.url,
    sha256: createHash("sha256").update(body).digest("hex"),
    bytes: body.length,
    body,
  });
}
