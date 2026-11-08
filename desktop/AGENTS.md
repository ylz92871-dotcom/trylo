# Desktop 开发约束

先遵守仓库根 `../AGENTS.md`，再读本工程 `README.md` 与当前任务的正式合同。源码、正式测试与合成 fixture、构建配置、锁文件、许可证和维护中的原生输入留在本工程；临时脚本、截图、日志、候选构建和过程记录进入根 `_workspace/`。

## 代码与状态边界

涉及 UI 实现、组件拆分或接线审查时，先读取并应用仓库内唯一的 [Trylo 代码质量技能](../new%20trylo%20cli/.agents/skills/trylo-code-quality/SKILL.md) 及其 [UI 可维护性规则](../new%20trylo%20cli/.agents/skills/trylo-code-quality/references/ui-maintainability.md)。这是工程 Agent 的明确读取入口，不改变产品技能发现或用户运行状态；CLI 专用阶段与迁移规则不套用到 Desktop。

- React 组件放在 `src/components/<领域>/`，结果与版本数据归 `src/results/`，原生宿主协议与 IPC 归 `src/host-adapter/`，Rust 命令归 `src-tauri/src/commands/`。不要在新组件中散写原生调用。
- 文件系统与项目状态是权威来源；编辑器和 Agent 通过现有 Workspace/宿主合同读写，不各建一套文件或执行状态。
- 新功能样式通过 `src/index.css` 统一引入，使用现有主题与布局约定。历史原型不作为生产实现的第二份源码。
- 新文件先确定归属；一项概念保留一个权威实现。文件优先控制在 300 行内；超过 500 行或持续增长时，审查职责、状态所有者和生命周期，按真实边界决定拆分，不机械切文件。新增功能不能继续向根组件堆积无关状态、effect 和业务分支。
- TypeScript 保持 strict，不新增无依据的 `any`；Rust 测试外不使用 `unwrap()`。注释解释原因，不堆失效代码或没有处理安排的 TODO。
- 新依赖先检查现有能力，并记录用途、隔离与替换边界、许可证及传递依赖闭包；整理文件不授权引入依赖或改产品机制。

## 开发与验证

网页开发入口是 `npm run dev`，Vite 保持端口 1420；原生开发沿用 `pnpm tauri:dev`。单套 `node_modules/`、`dist/` 与 Rust `target/` 遵循工程约定，运行中的 `.trylo/` 等数据不得随整理重定向。

正式合成验收入口放在 `testdata/`；保留的早期工程规范见 `docs/spikes/`。旧文档的日期、Spike 阶段与分支描述只作当时背景，不能覆盖当前实现或用户决定。

按改动选用既有定向测试、类型/静态检查及相应 Rust 检查；UI 至少保留必要烟测。原有覆盖目标为宿主/服务 70%、Rust commands 60%。目录整理仅做必要完整性与路径检查，不触发付费模型、完整长测或原生发行验收；真实提供商、原生 Desktop 与安装包结果分别报告。

保留用户现有修改与失败证据。未经明确授权，不提交、打标签、stash、发布或调整系统权限。
