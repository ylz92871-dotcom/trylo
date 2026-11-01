# Desktop 默认统一使用 new trylo cli

日期：2026-10-24。依据：用户要求“后面全部换成默认是 new trylo cli”。状态：开发配置、运行时默认值与旧配置迁移已修改并验证；未提交，未重打安装包。

## 生效行为

- 标准开发与发行配置均为 `trylo-v1` / `VITE_TRYLO_NEW_CLI_ONLY=true`。新增可共享的 `.env.development`，本机 `.env.development.local` 的录制用 legacy 回退改为新版。发行配置此前已经是新版，本次保持一致。
- 默认 `cliPath` 留空，通过既有原生 resolver 解析新版入口及对应 Node。开发启动脚本原本已指定 checkout 的 `new trylo cli/dist/cmd/trylo/main.js`，无需更改原生代码。
- 已保存的 legacy 选择在标准开发版也会转换为新版运行快照，并同步清空旧版入口。即使协议已是新版，也会识别历史 C: / D: 旧默认路径及大小写、反斜杠变体。真实自定义新版入口保留。
- Code、Work 请求漏传协议时，控制器、进程身份与预热判断都使用唯一的 `DEFAULT_CLI_RUNTIME_PROTOCOL`，不再隐式选择 legacy 或预热旧进程。
- 显式兼容构建的 legacy 路由仍保留；其预热指纹与接管后的协议也明确记录，避免默认值改变影响显式兼容测试。

旧路径识别集中在纯模块 `cli-runtime-path-defaults.ts`，设置迁移无需依赖 Tauri adapter。没有新增持久化字段或依赖。

## 配置保护与使用

运行快照迁移不写回原始 localStorage。连接、模型、凭据、权限和学习设置不变，原有存储仍可恢复。切换协议与入口同时完成，避免给旧入口发送新版 argv。

刷新或重启现有开发 Desktop 后，新启动的 Code / Work 任务使用新版。已在运行的旧 CLI 不会热更新；本次没有强制停止用户任务。另一个已安装版本需要包含这些改动的发行包才能获得同样默认值。

新版仍执行既有 provider 验证；不支持自动映射的旧 Anthropic 格式连接需要显式配置新版 provider，不会为了启动而降回旧 CLI，也未改变全局 provider 或凭据。

## 验证

证据：[verification.json](evidence/new-cli-default-20261024/verification.json)。

1. 修改前保留红例：遗漏协议的 Code / Work 请求实际选择旧 runner、旧预热被启动、默认指纹属于 legacy；旧默认路径和真实开发环境优先级也被新测试捕获。首轮测试曾因 jsdom 中导入 Vite/esbuild 产生环境错误，随后将真实配置测试移到 Node 环境，保留原始输出后重新取得行为红例。
2. 17 个相关测试文件共 196 项：主检查 194 通过、1 失败、1 跳过；唯一失败为多子任务 UI 的等待超时。在仓库外规范临时目录、单 worker、静态检查结束后复验该文件，2/2 通过，无断言或超时阈值修改。合并覆盖为 195 项通过、1 项既有跳过。主检查原始失败仍保留，未改写为全绿。
3. 新增配置测试使用 Vite 实际 `loadEnv`，验证开发和生产配置以及本地文件优先级；迁移测试确认原始存储和连接信息不被更改。控制器明确验证 Code / Work 默认新版及没有旧预热。
4. 新 CLI 实际进程用例覆盖写入审批、后续轮次、恢复及清理；多子任务真实 CLI 进程与生产 UI 组件的输入/停放恢复亦通过。本地 provider fixture 不等于真实供应商或原生 WebView2 验收。
5. Desktop TypeScript `--noEmit` 退出 0；11 个改动 TS/TSX 文件严格 ESLint `--max-warnings 0` 退出 0。后续仅整理注释及等价 re-export 位置，没有改变已验证逻辑。

部分原有测试刻意验证 legacy 的 warm/prewarm 行为，之前依赖漏传协议取得旧默认。本次将这些测试夹具显式标为 legacy，保持原断言和兼容范围；新增用例单独断言真正的缺省行为使用新版。切换中还补齐预热指纹的协议字段与接管时的 `ownedProtocol`，相关既有回归保持通过。

## 范围与回滚

本次源代码与环境配置范围见证据 `scope.json`，相对回合开始副本的修改见 `incremental.patch`。先前子智能体修复及其他工作区修改未纳入此次补丁。反向应用只执行 `--check`，未实际回滚；回滚前应核对当前哈希，避免覆盖并行改动。

本次不宣称安装包、原生窗口或所有供应商连接完成验收。没有重建或改动两个 CLI 的源码/二进制；验证使用现有新 CLI 构建。
