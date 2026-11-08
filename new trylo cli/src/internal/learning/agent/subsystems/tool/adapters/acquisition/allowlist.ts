/**
 * 出站白名单（P05 工具学习规格 §3 + §4）。
 *
 * 这是整个 CLI 里唯一一张「可以主动跟谁说话」的名单。它不是配置，是**硬编码
 * 常量**：一个能被改写的白名单等于没有白名单，而这一层存在的全部理由就是
 * 「不让 Agent 顺手从任意域名取东西」。
 *
 * 首版四个平台由所有者 2026-09-17 拍板（**可减不可私加**）。加一个平台要改的
 * 只有这个文件，但这正是它该是一件难事的地方——白名单的每一次扩张都该被看见。
 */

export type Platform = "github" | "npm" | "pypi" | "mcp_registry";

/**
 * 一个平台的两扇门：问元数据走哪、取字节走哪。
 *
 * 分开是因为它们常常不是同一个主机（GitHub 的 API 与归档分居 `api.github.com`
 * 与 `codeload.github.com`；PyPI 的元数据与文件分居 `pypi.org` 与
 * `files.pythonhosted.org`）。合并成一张表会让「只该问元数据的主机」也能被用来
 * 下载。
 */
export type PlatformDoors = {
  readonly platform: Platform;
  readonly apiHosts: readonly string[];
  readonly downloadHosts: readonly string[];
};

export const PLATFORM_DOORS: readonly PlatformDoors[] = [
  {
    platform: "github",
    apiHosts: ["api.github.com"],
    downloadHosts: ["codeload.github.com", "github.com", "objects.githubusercontent.com"],
  },
  {
    platform: "npm",
    apiHosts: ["registry.npmjs.org"],
    downloadHosts: ["registry.npmjs.org"],
  },
  {
    platform: "pypi",
    apiHosts: ["pypi.org"],
    downloadHosts: ["files.pythonhosted.org"],
  },
  {
    platform: "mcp_registry",
    apiHosts: ["registry.modelcontextprotocol.io"],
    downloadHosts: ["registry.modelcontextprotocol.io"],
  },
];

const HOST_TO_PLATFORM: ReadonlyMap<string, Platform> = new Map(
  PLATFORM_DOORS.flatMap((door) =>
    [...door.apiHosts, ...door.downloadHosts].map((host): [string, Platform] => [host, door.platform]),
  ),
);

/** 白名单域的全集。`guard.ts` 逐跳拿它核，改这里就是改门。 */
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set(HOST_TO_PLATFORM.keys());

export function allowedHosts(): readonly string[] {
  return [...ALLOWED_HOSTS];
}

export function platformOf(host: string): Platform | undefined {
  return HOST_TO_PLATFORM.get(host.toLowerCase());
}

export function isAllowedHost(host: string): boolean {
  return HOST_TO_PLATFORM.has(host.toLowerCase());
}
