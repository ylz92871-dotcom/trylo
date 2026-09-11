# Trylo Code 官网 — 部署说明

## 现状（2026-09-06 起）

- Cloudflare Pages 项目：**trylocode**（Direct Upload，**不接 Git**）
- 域名：`trylocode.me`（主）、`app.trylocode.me → /app/`、`chat.trylocode.me → /chat/`（Pages 自动重定向）、`trylocode.pages.dev`
- 站点源码在本仓库 `trylocode-site/`，其中 `app/releases` 是指向 `../mobile-app/releases` 的符号链接（APK 不入库）

## 发布一个新版本

```bash
cd trylocode-site
node deploy.mjs
```

脚本会把站点复制到临时 staging（`app/releases` 符号链接解引用成真实 APK，
排除 `REDESIGN-PLAN.md`/`DEPLOY.md`/脚本自身），再 `wrangler pages deploy` 上线。
首次或凭证过期时先 `npx wrangler login`。

## 注意

- **改完必须手动重新部署**——没有 Git 集成，push 到 trylo 仓库不会触发发布。
- APK 与页面同源分发，Pages 单文件上限 25 MiB（当前 24.2 MB 的 APK 合规）。
  如果未来 APK 超 25 MiB，要改用 GitHub Releases 或 R2 外链。
- 旧插件仓库（`claude-code-v-2.1.88-main/.../trylocode-site`）自本日起只是存档，
  那边不再部署。
