# New Trylo CLI

Trylo CLI 的全新工程化实现工作区。核心目标为打造具有可信版本基线、真实质量门禁、清晰生产可达性、Windows 平台证据、兼容协议与可审计发行物的 Agent CLI 内核。

## 工程现状与架构分层

当前新 Trylo CLI 处于 **P00 工程地基与横向收口** 阶段（覆盖 P01–P07 已施工模块，正在建立严格的工程质量基线）：

- `src/cmd/trylo/`：CLI 用户表面与主入口（`main.ts`、命令分发、`auth`、`mcp`、`checkpoint` 等）
- `src/internal/ports/`：纯接口与协议契约端口定义（与外部解耦）
- `src/internal/adapters/`：各类外部系统适配器（provider、credentials、mcp、session-store、tools 等）
- `src/internal/loop/`：核心 Agent Loop、状态机、事件流与执行器（`runner.ts`、`stream.ts` 等）
- `src/internal/domain/`：领域模型与状态转移规约
- `src/internal/protocol/`：Trylo Protocol 权威信封与事件契约定义
- `src/internal/subagent/`：子代理生命周期与调度执行治理
- `src/internal/learning/`：双循环学习控制面与规则账本

## 质量门禁与测试分层

CLI 默认使用模型生成上下文摘要；模型错误、取消、截断、空输出或安全校验拒绝时回退摘录。可用 `--compact-summary=extractive` 显式选择纯摘录，`--compact-summary=model` 显式选择模型作者。摘要使用本轮同一显式输出/费用预算；未设置生成额度时不添加固定输出上限。底层没有 provider 的压缩服务仍可使用纯摘录原语。

根据《新 Trylo CLI 代码质量与工程化优化方案》，项目实施严格的分层测试与验证体系：

```bash
# 1. 执行全部 Hermetic 自动化测试（不依赖外部凭据或真实操作系统敏感状态）
npm test

# 2. 执行平台专属测试（在支持 Windows Credential Manager 的受控环境下运行）
npm run test:platform

# 3. 运行全量工程质量门禁（12 步管线，从基线、类型、架构、测试到许可审计）
npm run verify

# 4. 构建 TypeScript 源码
npm run build
```

## 权威规范与参考文档

- 优化主方案：`docs/02-分期工程产出/P00-工程地基与质量门禁/2026-09-18-方案-新Trylo-CLI代码质量与工程化优化.md`
- 架构纪律：`docs/00-总领/代码可读性可维护性与审计纪律.md`
- 开源准入：`docs/00-总领/开源依赖与参考代码准入政策.md`
- 地基规格：`docs/01-分期施工总技术文档与架构/P00-工程地基与协议冻结技术规格.md`
- 拓扑与许可 ADR：`docs/02-分期工程产出/P00-工程地基与质量门禁/ADR-0001-官方发行拓扑与核心工具链许可.md`
- 日常使用与错误恢复：[CLI 会话与提供方错误恢复](docs/02-分期工程产出/P00-工程地基与质量门禁/2026-11-08-日常使用-CLI会话与提供方错误恢复.md)
