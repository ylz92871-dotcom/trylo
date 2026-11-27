# Linux 接入指南

公库已有 Linux 原生文件打开、平台配置和资源准备接入口。完整 Linux 适配待接入，prepare.mjs 会明确报告这一状态。

以共同 main 为基线，从现有 Linux 适配提取补丁。公共构建和校验归 desktop/scripts/build/shared/，Linux 通过公共模块复用。

| 能力 | 位置 |
| --- | --- |
| 窗口、文件夹选择与系统菜单 | desktop/src-tauri/src/platform/linux/ |
| 进程、PTY 与进程组 | CLI 的 adapters/process-session/ |
| 隔离执行 | CLI 的 adapters/sandbox/linux/ |
| 凭据存储 | CLI 的 adapters/credentials/linux/ |
| 电脑控制与显示环境探测 | desktop-services/src/tooling/computer-control/linux/ |
| 工具源码、版本和依赖 | toolchain/ 与 tooling/manifests/ |
| 资源准备、系统包和安装依赖 | desktop/scripts/build/linux/ 与 tauri.linux.conf.json |

电脑控制保留 linux-mcp 包标识。现有 Linux 参考实现以 Ubuntu 24.04 / X11 为基线，并报告 Wayland 电脑控制不可用。接入时记录发行版、架构、显示环境及权限。界面和 Agent 使用实际工具健康结果。Wayland 后续通过所属电脑控制模块增加实现。

先验证公共流程和原生启动，再验证工具、权限和资源闭包。deb 配置是构建目标，发行依赖、最低系统版本和真机运行需要随实现验收。

.github/workflows/linux.yml 当前运行公共源码与平台合同检查。原生编译和安装包验证在实现接通后补入，分别报告结果。
