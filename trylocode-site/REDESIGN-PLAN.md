# 官网改版设计计划 — Trylo（2026-09-03）

> 依据：`frontend-design` skill。原则=保留你已确立的品牌视觉（金色 #dcc97e / 深色底 / Space Grotesk + Inter + IBM Plex Mono），只重写**信息架构与文案**，让它从"VS Code 侧边栏插件"进化到"多端 Agent 产品"。风格你说没问题 → 不动 token、不动签名动画、不动 poster 幽灵标。

## 1. 产品现状对齐（事实来源见调研记录）

| 旧站在说 | 现在的真相 | 处理 |
|---|---|---|
| "运行在 VS Code 侧边栏" | 独立 Tauri 桌面 App + WPF 桌宠 + Android App + Cloudflare Web | 重写 hero/lead/features |
| 四种模式含 **Fun** | Fun 已移除，只剩 **Code**(chat/plan/agent/cognition) + **Work** | 模式区重构 |
| VS Code 扩展下载入口 | 无对外插件；桌面版待发布、App 已发布 | 入口改为 App 下载 + 桌面"即将发布" |
| "17 个文件 3 分钟搞定" | 保留为 Agent 卖点，但补 Work/学习 | 局部改 |
| 无 User Learning / 多端 / 远程 | 这是最大差异化 | 新增区块 |

## 2. Token 系统（沿用，仅登记）

- **色彩**：`--bg #0b0d10` / `--panel #14171c` / `--line #333947` / `--text #edf0f4` / `--accent #dcc97e` / `--accent-strong #f3e3a6` / `--bone #f2ede1`。金色=唯一强调，不改。
- **字体**：display=Space Grotesk；body=Inter+Noto Sans SC；mono=IBM Plex Mono。三档分工保持。
- **版式**：`--maxw 1180px`；eyebrow（mono 大写字距）+ 大号 display h2 + grid 卡片的既有节奏保持。
- **签名**：hero 三笔标志的 draw+settle 动画、poster 幽灵标、maker 签名标 —— 全部保留（这是品牌记忆点）。

## 3. 新信息架构（主站 index.html）

1. **Nav**：把"四种模式"→"产品能力"，去掉 VS Code CTA，右侧改「下载 App ↗」（app.trylocode.me）+ 保留"在线体验"。
2. **Hero**：
   - eyebrow：`Your agent-native development partner`（去掉 "in your sidebar"）
   - h1：保留"从想法到代码"结构，副句升级为多端。lead 重写：独立桌面 + 手机 + 桌宠 + 会学习你。
   - hero-meta：`本地优先 · 密钥不出本机` 保留；`Plan/Agent/Chat/Fun` → `Code / Work · 桌面·手机·桌宠`
3. **Poster**："不是只会补全的工具，而是会思考、执行、对话、**记住你**的搭档。"（四动词收进学习）
4. **能力/模式区（原四种模式）**：改为 **Code 与 Work 双模式** 两张大卡 + 一列"能力"：
   - Code：chat / plan / agent / cognition（四子模式，含"了解我"入口）
   - Work：交付物感知工作流（PPT/Office 全链路、PhaseRail、审批节点、ResultDock）
   - 移除 Fun 卡。
5. **新增「多端」区**：Desktop / Android App / 桌宠 Trylo Miu / Web 四张卡（结构=真实的四个发行面，非装饰编号）。
6. **新增「User Learning」区**（头号差异化）：Evidence→Conclusion→Policy 主链的通俗化叙述 + Cognition + Shadow-first 安全承诺。措辞成熟度中性，不吹未上线能力。
7. **Features 区**：本地优先 / 密钥不出本机 / 多端同步（扫码配对+Cloudflare Tunnel+一次性 ticket）/ 安全审批文化（fail-closed）/ 工具平台（OfficeCLI·Playwright·Windows-MCP·DevTools MCP）/ 工程可靠（Vitest 1386+353+301 全绿）。把旧"原生侧边栏体验"改为"原生桌面 + 手机"。
8. **Maker / footer**：基本保留，footer 链接文案与新增产品页对齐。

## 4. 下载页 app/index.html（修 bug + 换品牌）

- 这是当前**唯一有线上故障**的页：所有 `href="releases/Trylo-Remote-v0.x.apk"` 都指向已不存在的文件（releases 现仅 Trylo-Code-v1.1.4/5/6）。
- 改：标题/meta 从 "Trylo Remote" → "Trylo Code"；latest=1.1.6；更新日志保留历史 1.0–1.1.4（来自 CHANGELOG），补 1.1.5/1.1.6 为"维护更新"（**注：这两版无 CHANGELOG 记录，我会标为「小版本迭代」，等你补真实内容**）；移除猫箱字样或改为"远程·审批"。
- 移除对 Trylo-Remote 死链；旧 0.x 历史若仍想展示，改为不挂下载或注明"历史版本已下架"。

## 5. remote/index.html（次要）

- 文案里"连接电脑"表述从"VS Code 插件"改为"Desktop"；去猫箱字样。改动量小。

## 6. 设计自查（避免 AI 默认审美）

- 不引入 cream+serif+terracotta、不引入纯黑+单一霓虹、不做 broadsheet 细线栏——**沿用你既有的深灰蓝+暖金**，本就规避了三类模板默认。
- 结构编号（多端/主链）都对应真实并列/有序关系，非纯装饰。
- 动效仅在 hero 标志与 hover 微交互，克制。

## 7. 风险与待你拍板

- 桌面版无安装包：主站 CTA 不指向不存在的下载；如你已有内部 build 想放出，告诉我路径。
- App 1.1.5/1.1.6 无 changelog：先占位，别编造功能。
- chat.trylocode.me 旧三模式 Demo 与桌面不一致：主站弱化入口，页面本身暂不改（可选下架）。
