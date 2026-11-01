# 公开源码整理与迁移顺序

> Current source decision (2026-10-15): main working-tree fixes are synchronized, trylo-v1 is the default, and legacy CLI source/engine staging are excluded. [Synchronization record](../release/MAIN_SOURCE_SYNC_2026_10_15.md). Earlier R3 artifact notes describe their historical download, not this source default.
> 2026-10-15 source audit: the Windows-MCP fork, tool registry, Tauri icons and sandbox source inputs are now included. See [source completeness](../release/SOURCE_COMPLETENESS_2026_10_15.md). Historical migration plans and release limitations below remain distinct.
> 状态：待审
> 阶段：公开源码整理，第一批
> 负责人：Trylo 项目维护者
> 最后更新：2026-10-15
> 依赖决策：新版 CLI 公开；先在副本整理，保留已有未提交修改，现已授权提交当前源码开发快照。

## 当前与目标

| 当前位置 | 公开目标 | 迁移方式 |
| --- | --- | --- |
| new trylo cli | trylo-cli | 保留 src/internal 逻辑分层和 package-lock；先不拆多个 npm 包 |
| desktop | desktop | 保留入口与真实模块；另批拆解 App 和旧 runtime 路由 |
| desktop-services | desktop-services | 维持服务宿主与外围能力边界 |
| work | work | 显式补齐 vendor 获取/构建闭包，保留适配隔离 |
| mobile-app | mobile-app | 保留可构建 Android 配置，排除签名和生成包 |
| trylocode-site | （不公开） | 自 2026-11-02 起官网源码不进入公库，只保留线上下载入口 |
| 新 CLI vendor-bin/pty | native/pty | 移动自产源码及 provenance，修正打包定位 |
| Windows-MCP/native/wgc-helper | native/wgc | 移动 helper 源码，修正原生构建及来源记录 |
| 精选/重写架构说明 | docs/architecture | 以现状和已定意图分别陈述，历史记录不直接变成设计规范 |

第一批在 .local-release/source-preview 下生成目录映射预览，不移动仍被当前开发脚本引用的原始目录。它是同一副本里的本地预览，无 Git 历史、无远程地址，不是新的公库。

## 六个施工批次

1. **架构与公开边界**：模块职责、状态所有者、目录映射、文件 allowlist、排除原因和风险登记；本批交付。
2. **新版 CLI 与自产原生组件**：规范目录名、修正构建/测试/PTY 定位、沙箱静态闭包与固定获取过程；验证 CLI 源码构建、完整质量门禁和离线安装包。
3. **Desktop/Services 接线**：以新版 CLI 作为公开产品唯一路径；清理旧启动路径和 shadow runner 参数，修正配置迁移及浏览器 profile 合同；此批必须在删除旧路径前完成端到端验收。
4. **Work/移动端/网站**：明确 workd 依赖边界和固定组装；合成夹具替换真实任务录制；远程连接/取消/恢复合同；网站路径及 Release 下载链接。
5. **许可证与干净克隆**：补齐 LICENSE/NOTICE/SBOM、来源与补丁、无密钥与私有数据；新目录无本机缓存地安装、构建和运行检查。
6. **公库更新与发行**：把已验收源树导出到公库现有历史上的候选分支；生成 review diff 与独立源码包/安装包清单，再提交推送。当前已获准先提交源码开发快照；完整目录迁移和发行另行验收。

各批次可继续细分，但每个实际 Git 提交必须自洽可构建。涉及 CLI 目录改名、Desktop stage-cli、原生 helper 定位的修改，需要在同一可构建提交中闭合；不能提交中间断链状态。

## 必须保持的约束

- 核心不得导入 UI/provider/storage 实现；adapter 依赖端口，UI 依赖版本协议。
- 一个 Run/Turn、approval、learning proposal、artifact 只有一个权威类型、生命周期 owner 和写入口。
- 目录迁移不得改变权限、收集/保留规则、取消/恢复、任务终态语义。
- 用户学习、Agent 学习和执行的产品地位不变；本批不改学习机制。
- 新旧路径不使用静默 fallback 掩盖缺失的公开依赖；缺失必须报可定位错误。
- 现有失败和未验证项保留；不删测试、不把跳过依赖视为通过。
- 先沿用各包锁文件；统一包管理器另行记录原因和成本。
- 每次验证针对同一个冻结源树和安装制品，避免共享 dist 相互覆盖。

## 如何查看第一批

```powershell
node scripts/release/source-tree.mjs
node scripts/release/source-tree.mjs --report .local-release/source-plan.json
# 只允许新目录；若已存在，脚本拒绝覆盖。
node scripts/release/source-tree.mjs --preview .local-release/source-preview --report .local-release/source-plan.json
```

清单包含源路径、公开目标路径、字节数、SHA-256、排除原因、只定位不打印内容的凭据线索，以及尚未关闭的发布阻断项。脚本不会安装依赖、写 Git index、创建提交、配置远程或推送。

## 当前阻断项

- Desktop 默认已切换 trylo-v1；显式旧协议适配与 shadow 调用仍需独立验收。
- CLI/website/native 的新路径尚未进入现有构建脚本。
- 沙箱静态 JS 与类型声明已纳入源码；原生/沙箱预编译 helper 仍需固定获取或重建过程。
- workd 仍依赖未进入公库的上游完整树；不通过省略功能或测试隐藏。
- 历史文档中的真实执行夹具和测试读取关系需要梳理。
- 既有公库 NOTICE 仍描述 Claude Code；应按新的实际分发闭包更新，保留应保留的上游归属。
- 前次 Desktop 关联检查有 5 项 browser-profile 合同失败；本批未重跑或声称已修复。
- 当前整理后的干净克隆、原生安装包与移动真机验收尚未进行。
