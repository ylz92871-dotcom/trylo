# Trylo logo

## ✅ 最终版 / FINAL — `trylo-logo-final.*`

**这是 Trylo 品牌标识的最终版本，所有场景一律以此为准。**

| 文件 | 用途 |
|---|---|
| `trylo-logo-final.svg` | 源文件（矢量，首选） |
| `trylo-logo-final-1024.png` | 应用图标 / 商店 / 大尺寸 |
| `trylo-logo-final-512.png` | README / 网页 / 常规展示 |
| `trylo-logo-final-256.png` | 小尺寸 / favicon |
| `trylo-logo-final-192.png` | Android 自适应图标前景参考 |

### 规范

- **图形**：4 笔「X」形标记（Z-up / S-down），与桌面端顶栏、空状态、Work 启动页、安装器图标、手机端 launcher 完全一致——**一个 Trylo，一个标记**。
  权威定义在 `desktop/src/components/brand/Logo.tsx`，本文件按该定义生成。
- **金色渐变**：`#F0DE91` → `#DEC86F`（0.55）→ `#C6AB50`，渐变端点 (232,220) → (812,804)。
- **底色**：Trylo 黑 `#0E0E0E`，圆角半径 224 / 1024（PNG 圆角外为透明）。
- **描边**：`stroke-width="64"`，随图形整体放大 1.36 倍 → **实际描边 ≈ 87**，`round` 端点与连接（小尺寸下保持实心感，不发虚）。
- **尺寸与留白**：标记在 1024 画布中经 `translate(-210.16 -146.24) scale(1.36)` 放大并做光学居中，**实际占画布约 76%（76.1% × 74.3%）**，四周留白 ≈ 122/123/131/132 px（已接近圆角安全区，不要再放大）。
- **小尺寸（≤32px）**：使用 `trylo-logo-final-256.png`，不要用渐变版描边过细的旧稿。

### 已废弃 / deprecated

- `trilo-logo-transparent.svg` — 米白（bone）描边版，仅深色底可用，**不再作为品牌主标识**，保留仅作兼容。
- 蓝标白底的 `ic_launcher` 系列（`mobile-app/.../mipmap-*`）与网站 `assets/trylo-icon.svg` — 旧设计，后续统一替换为最终版。
