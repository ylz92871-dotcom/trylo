# Trylo 项目架构

状态为已批准的三端架构整理，依据 2026-11-27 项目所有者决定。本文描述公库当前模块与接入边界。旧目录方案可在 Git 历史的 456e450 版本中查阅。

## 项目结构

```text
desktop/
  src/                       共用 React 工作台、Code / Work、设置与结果
    host-adapter/            界面调用本机能力的接口与 Tauri 接线
    styles/components/       共用样式
    styles/platforms/        系统局部样式的接入约定
  src-tauri/
    src/commands/            IPC、参数与路径验证、现有生命周期
    src/preview/             格式预览及所属的浏览器、媒体、Office 后端
    src/platform/
      windows/               Windows 启动标志、文件打开、文件夹选择
      macos/                 Mac 文件打开；文件夹选择待接入
      linux/                 Linux 文件打开；文件夹选择待接入
    tauri.conf.json          公共配置
    tauri.windows.conf.json  Windows 资源与安装包
    tauri.macos.conf.json    Mac 打包目标，资源实现待接入
    tauri.linux.conf.json    Linux 打包目标，资源实现待接入
  scripts/build/
    prepare.mjs              按构建机器选择资源准备入口
    shared/                  CLI、npm、工具清单导出、预览引擎与校验
    windows/                 Windows 工具、桌宠、运行权限及打包
    macos/                   Mac 资源准备接入口，目前报告待接入
    linux/                   Linux 资源准备接入口，目前报告待接入
new trylo cli/
  src/internal/
    domain/ loop/ protocol/ ports/    共用执行状态、流程、协议和接口
    learning/                        共用学习系统
    adapters/
      process-session/               进程与终端
      sandbox/platform-isolation.ts  隔离执行的平台选择入口
      sandbox/windows/               Windows 隔离实现
      credentials/windows/           Windows 凭据实现
desktop-services/
  src/
    host.mjs                 服务入口与生命周期
    protocol/ remote/        服务协议和远程连接
    tooling/
      manifests/             工具版本、来源、平台与依赖
      browser/               浏览器会话、CDP、预览与流
      computer-control/
        platform.mjs         选择电脑控制包
        windows/             Windows 权限探测与电脑预览
        macos/               Mac 包接入口，原生工具待接入
        linux/               Linux 包接入口，原生工具待接入
  toolchain/                 工具源码与原生辅助程序
mobile-app/                  手机端
remote-relay/                远程中继
scripts/                     全仓开发与源码检查
docs/                        架构、开发与发布文档
```

官网工程的公开范围遵循根 README。开发数据和候选包保存在被忽略的 _workspace/。根目录按工程划分，平台实现归各自工程。

## 调用与依赖

用户操作进入 React 工作台，经 host-adapter 交给原生宿主或本地服务。会话监督通过 Trylo Protocol 启动 CLI，CLI 调用模型、工具和系统适配器，将执行事实返回工作台。CLI 使用自己的 ports 与领域类型，不能依赖 React、Tauri IPC 类型或 Desktop Services 的内部实现。

原生命令先验证参数和允许的文件范围，再调用 platform 选择的实现。例如成果路径验证继续由 commands/work_host.rs 持有，platform/*/open.rs 只负责启动系统程序。IPC 名称、参数、结果和权限语义保持兼容。跨功能的系统操作归 platform；只服务于预览或浏览器的原生后端留在所属功能模块，按该功能接口选择系统实现。

Services 的 tooling 持有工具安装、健康检查和每轮工具配置。computer-control/platform.mjs 按系统选择工具包。它不把平台名称当作可用性证明，也不替代用户电脑控制开关和 CLI 审批。工具包管理器复用同一平台选择来确定内置工具归属。缺失的 Mac/Linux 工具返回局部不可用结果，其他工具和会话继续执行。

## 状态所有权

| 状态 | 所有者 |
| --- | --- |
| 执行、取消、恢复和任务终态 | CLI 既有执行模块 |
| 权限与每轮授权快照 | 既有 Permission 与宿主审批链 |
| 学习调度和资产 | CLI 既有学习控制面及所属子系统 |
| 会话监督与视图状态 | Desktop 既有监督器、仓库与投影 |
| 原生窗口和宿主子进程 | Tauri 既有原生状态与关闭流程 |
| 工具安装、健康和服务连接 | Desktop Services 对应服务 |

各系统适配返回原合同中的真实结果与失败，不能另建执行或权限状态。

## 平台构建

Tauri 构建时合并公共配置与当前系统配置。正常入口仍是 desktop 中的 pnpm tauri:dev 和 pnpm tauri:build。beforeBuild 经 scripts/build/prepare.mjs 选择资源准备入口。Windows 调用 scripts/build/windows/prepare.ps1。公共预览脚本和输入清单位于 shared/preview。CLI 组装接受 --node 指定已经准备的目标平台解释器，原 Windows 调用继续使用默认路径。

现有预览引擎的锁文件和已审计重建配方整体归 shared/preview，其中 media-build/windows.sh 和相应固定工具链仍属于 Windows 引擎配方。Mac/Linux 接入时分别提供自己的已验证配方与锁文件，通过引擎接口选择；公共校验不依赖另一系统的适配目录。

共享开发启动入口继续负责选择平台及协调现有 Cargo/Tauri 生命周期。其中 Windows 关闭旧窗口、重建与完整性设置仍按原启动顺序执行，资源准备脚本已归 windows/。这次没有重写开发进程监督流程。

Windows stdin 辅助模块的受保护缓存跟随 sandbox/windows 布局，缓存标识绑定布局和捕获内容，以区分旧布局。旧缓存按原版本保留。

资源布局遵循宿主 node_runtime.rs 和现有 CLI staging 的合同。修改布局时同时核对生成方、查找方和校验方。版本与摘要由组件锁文件、工具 manifest 持有。

当前公库只完成 Windows 资源准备接线。Mac/Linux 准备入口明确失败并给出开发指南，避免生成错误平台的安装包。已有 Beta 安装包沿用原发布来源和验证范围。

## 双线同步

完整本地开发库与公库可以分别推进。本次只整理公库。同步本地旧路径的改动时，冻结共同基准，按文件迁移表做三方合并，保留公库已经建立的接口和修复。源码导出目录是待审候选，不能直接覆盖当前公库目录或推送完整私有历史。

## 合作者接入与验证

[Windows 开发](../development/windows.md) · [Mac 接入](../development/macos.md) · [Linux 接入](../development/linux.md)

先接系统适配和必要接口，再审界面调整。Code / Work 使用共享组件与相同接线。系统样式覆盖限定平台范围。新增接口说明调用者、状态所有者、失败与取消语义。

公共逻辑使用已有软件测试，各系统原生操作在对应环境验证。源码检查、TypeScript/Vite 构建、CLI 检查、服务测试和 Rust 检查分别留证。安装包额外验证随包 CLI、Service Host、依赖和启动。

[文件迁移表](platform-migration.json) 记录新旧路径。[本轮验证记录](../../new%20trylo%20cli/docs/02-%E5%88%86%E6%9C%9F%E5%B7%A5%E7%A8%8B%E4%BA%A7%E5%87%BA/P00-%E5%B7%A5%E7%A8%8B%E5%9C%B0%E5%9F%BA%E4%B8%8E%E8%B4%A8%E9%87%8F%E9%97%A8%E7%A6%81/2026-11-27-%E9%AA%8C%E6%94%B6%E6%91%98%E8%A6%81-%E8%B7%A8%E5%B9%B3%E5%8F%B0%E6%9E%B6%E6%9E%84%E6%95%B4%E7%90%86.md) 分开列出通过、原有失败与未验证项。原始证据位于 _workspace/tasks/platform-foundation-20261127/。
