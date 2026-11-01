/**
 * 候选获取层（P05 工具学习规格 §3）。
 *
 * 这一层补的是一个**实测缺口**：在它之前，`src/internal` 全域没有任何通用的对外
 * 取字节能力——只有「下载器合同」而没有实现。现在它有了，但同时被收得极紧：
 *
 *  - **一个口。** 所有对外请求都走 `guardedGet`，而它只认白名单、只锚 https、
 *    每一跳都重新查域。想确认「有没有别处在偷偷发请求」，`grep node:https` 即可。
 *  - **传输不写盘。** 取回来的是字节加哈希；显式 npm 收容入口另行消费 Permission
 *    授权、审计实际 tar 字节并写入固定隔离子树。检索和自动 worker 不能调用收容入口。
 *  - **不判政策。** 许可证是否可接受、候选是否可以试用，全部归既有的评估与
 *    vetting。这一层只回答「这个平台怎么问」和「答回来的东西长什么样」。
 */

export {
  ALLOWED_HOSTS,
  PLATFORM_DOORS,
  allowedHosts,
  isAllowedHost,
  platformOf,
  type Platform,
  type PlatformDoors,
} from "./allowlist.js";
export { fetchArchive, type FetchedArchive } from "./fetch-archive.js";
export { fetchJson } from "./fetch-json.js";
export {
  MAX_ARCHIVE_BYTES,
  MAX_JSON_BYTES,
  MAX_REDIRECTS,
  REQUEST_TIMEOUT_MS,
  USER_AGENT,
  allow,
  guardedGet,
  type AcquisitionFailure,
  type GuardedResponse,
} from "./guarded-get.js";
export {
  createHttpsTransport,
  type HttpTransport,
  type HttpTransportRequest,
  type HttpTransportResponse,
  type TransportFailure,
} from "./transport.js";
export * from "./platforms/index.js";
