// Trylo Code 官网部署脚本 —— Cloudflare Pages（项目名 trylocode，Direct Upload）
//
// 用法：在 trylocode-site/ 目录下执行
//   node deploy.mjs
//
// 做两件事：
// 1. 把站点复制到临时 staging 目录（-L 解引用 app/releases 符号链接 → 真实 APK；
//    排除 REDESIGN-PLAN.md 等非站点文件），保证 APK 会跟着一起发布；
// 2. 调 wrangler pages deploy 发布到 production（--branch main）。
//
// 前置：`npx wrangler login` 已登录（凭据在 xdg.config/.wrangler）。
// 注意：本站是 Direct Upload，不走 Git 集成；改完站必须重新跑一次本脚本。

import { cpSync, rmSync, mkdtempSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const project = "trylocode";
const branch = "main";
// 不随站点发布的文件
const exclude = new Set(["REDESIGN-PLAN.md", "deploy.mjs", "DEPLOY.md"]);

const staging = mkdtempSync(join(tmpdir(), "trylo-site-"));
cpSync(here, staging, {
  recursive: true,
  dereference: true, // app/releases（符号链接 → mobile-app/releases）落成真实 APK
  filter: (src) => {
    const rel = src.slice(here.length + 1);
    if (!rel) return true;
    // 顶层文件按排除表；releases 里的 .idsig 保留（Play 安装器校验用）
    return rel.includes("/") ? true : !exclude.has(rel);
  },
});

const files = readdirSync(staging, { recursive: true }).length;
console.log(`staging: ${staging} (${files} 个文件，含 APK)`);

const r = spawnSync("npx", ["--yes", "wrangler@latest", "pages", "deploy", ".",
  "--project-name", project, "--branch", branch, "--commit-dirty=true"],
  { cwd: staging, stdio: "inherit", shell: true });

rmSync(staging, { recursive: true, force: true });
process.exit(r.status ?? 1);
