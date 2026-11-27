# Windows 开发

默认桌面入口是 desktop 中的 pnpm install --frozen-lockfile 和 pnpm tauri:dev。打包入口是 pnpm tauri:build。

先按 [公开源码构建说明](build-from-source.md) 准备 CLI、服务与原生输入。资源准备入口 desktop/scripts/build/prepare.mjs 调用 windows/prepare.ps1。Node、Office、媒体、WGC 和桌宠沿用原来的固定输入和校验。

原生系统操作位于 desktop/src-tauri/src/platform/windows/。电脑控制宿主适配位于 desktop-services/src/tooling/computer-control/windows/，工具源码保留在 toolchain/computer-control/Windows-MCP/。CLI 隔离与凭据的 Windows 实现分别位于 adapters/sandbox/windows/ 和 adapters/credentials/windows/。

命令参数、路径验证、执行状态及审批由原模块持有。修改原生启动时核对关闭和进程停止行为。原有测试入口继续验证移动后的实现。

当前目录整理没有重新发布安装包。原生构建和安装验证结果以对应任务记录为准。

## 原生检查准备

先完成前端 build，再执行 Cargo 检查。Rust 进程测试使用 desktop/src-tauri/resources/runtime/node/win-x64/node.exe，须按 Windows prepare.ps1 中的固定版本与摘要准备该解释器。源码克隆本身不包含这份生成资源。受影响测试使用实际子进程，缺少运行时应报告环境失败，不能删除断言。
