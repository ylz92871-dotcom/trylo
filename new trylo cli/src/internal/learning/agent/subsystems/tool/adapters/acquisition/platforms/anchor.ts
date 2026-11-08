import { err, ok, type Result } from "../../../../../../../tooling/contract/result.js";
import { isAllowedHost } from "../allowlist.js";
import type { AcquisitionFailure } from "../guarded-get.js";

/**
 * 域名锚定（规格 §4 唯一新增的一条闸）。
 *
 * 问题是这样的：我们问的是可信平台（`api.github.com`），但**平台答回来的内容**
 * 里可能写着「官方仓库在这里：`https://evil.example.com/o/r`」。如果我们照单全收，
 * 那么「问可信源」这件事就白做了——投毒只需要污染一份元数据。
 *
 * 所以元数据里声明的每一个上游地址，都要拿白名单再过一遍。过不了就**整个候选
 * 作废**，不是降级：一份说不清自己上游在哪的元数据，没有任何一处值得相信。
 *
 * 顺带把 `git+https://…​.git` 这种 npm/pypi 常见的写法归一，以及把 `rel` 之类的
 * 非 URL 字段挡在门外——它解析不出主机，直接判不通过。
 */
export function anchorUpstream(raw: string): Result<string, AcquisitionFailure> {
  const normalized = raw.startsWith("git+") ? raw.slice(4) : raw;
  let url: URL;

  try {
    url = new URL(normalized);
  } catch {
    return err("domain_mismatch", `unparseable upstream url ${raw}`);
  }

  if (url.protocol !== "https:") {
    return err("domain_mismatch", `upstream must be https: ${raw}`);
  }

  if (!isAllowedHost(url.hostname)) {
    return err("domain_mismatch", `upstream ${url.hostname} is not on the outbound allowlist`);
  }

  return ok(`https://${url.hostname}${url.pathname.replace(/\.git$/, "")}`);
}
