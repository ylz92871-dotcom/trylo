# 从公开源码构建

当前可验证的 CLI 构建目标是 Windows x64、Node >=22。源码发布不要求把 node_modules、dist、Cargo target 或整个桌面安装包提交到 Git，但必需输入必须能从仓库、固定下载或已说明的源码构建步骤获得。

## 新版 CLI：首次准备

在仓库根目录执行：

```powershell
# 显式下载已有依赖的固定版本；不需要 API key，也不执行上游 npm 安装脚本。
node scripts/setup-cli-native.mjs --install
node scripts/setup-cli-native.mjs --check
Set-Location 'new trylo cli'
npm.cmd ci
npm.cmd run build
node scripts/quality/verify.mjs
```

准备脚本从官方 npm registry 获取 `@anthropic-ai/sandbox-runtime@0.0.73`，校验固定 SHA-512 后只提取两个原生 helper，再分别校验仓库 PROVENANCE 中的 SHA-256 与长度。不会安装上游 CLI、CA/MITM 组件或运行包脚本，不更改 provider 或凭据。已有文件校验失败时拒绝覆盖；需保留问题文件后再处理。

网络隔离机器可从官方地址取得同一包，再运行：

```powershell
node scripts/setup-cli-native.mjs --archive C:\downloads\sandbox-runtime-0.0.73.tgz
```

固定下载地址：<https://registry.npmjs.org/@anthropic-ai/sandbox-runtime/-/sandbox-runtime-0.0.73.tgz>。
完整性值固定在脚本中；两个可执行文件的摘要固定在 CLI 沙箱 `PROVENANCE.json` 中。`npm run build` 本身不联网获取 helper；它继续严格验证缺失、长度和哈希，不通过改清单或跳过检查来迁就不匹配制品。

## 必需输入清单

| 输入 | 交付/准备方式 | 当前边界 |
| --- | --- | --- |
| `vendor-bin/pty/win-x64/trylo-pty.exe` | 随源码仓库提供，475136 字节，SHA-256 `ae9f7f6606b34fff023edbb49b1cf187dbea50faa0b97c3208e99a1caf526ac4` | 自产 Rust ConPTY 辅助程序，协议 v2；源码、Cargo.lock 与 PROVENANCE 同目录 |
| `vendor-bin/srt-win-x64.exe` | 上述显式准备脚本 | 已有 sandbox-runtime 0.0.73 依赖，3070976 字节 |
| `vendor-bin/srt-win-arm64.exe` | 上述显式准备脚本 | 2737152 字节；CLI 当前打包清单要求同时携带两架构沙箱 helper，并不表示整套 CLI 已支持 ARM64 |
| CLI JavaScript 依赖 | CLI 目录 `npm ci` | 按 package-lock；不提交 node_modules |
| Desktop Node 运行时 | 本机 Node，或 `TRYLO_NODE_RUNTIME_DIR` 指向含 node.exe 的目录 | 打包脚本会复制实际 Node 并记录版本/摘要；尚未统一固定下载版本 |
| Windows-MCP/WGC 捕获 helper | 公库的 C# 源码与 csproj；见下方命令 | 桌面打包还检查固定摘要；自行重建不保证与历史制品逐字节相同 |
| 桌宠 | `desktop/scripts/build/windows/build-desktop-pet.ps1`，由 prepare-sidecars 调用 | .NET 9 SDK、Windows x64；输出无需入库 |
| OfficeCLI / Playwright MCP / Chrome DevTools / Windows-MCP | `node scripts/setup-repository-tools.mjs --install` | 既有固定版本/摘要安装器；浏览器本体及 CAD 宿主仍分别准备 |
| CoWork/workd | 实验性单独依赖，普通 Desktop 构建默认排除 | `-IncludeWorkd` 所需上游完整树尚未纳入公开构建闭包，不声称已补齐 |

PTY 若要从源码重建：在 Windows x64、Rust MSVC 工具链与 C++ Build Tools 就绪时，从 `new trylo cli/vendor-bin/pty` 运行 `cargo build --release --locked`。首次需要下载 Cargo.lock 指定的依赖，不能假设新机器已有缓存而直接要求 `--offline`。原记录使用 rustc/cargo 1.97.1；任意本地工具链的产物不保证与固定 SHA-256 一致。不要为了让门禁通过而随意改 provenance；更新制品需独立审查。通常直接使用仓库内固定制品即可。

## Desktop：源码组装入口与限制

这次补充只闭合 CLI 原生输入，不等于发布了新的 Desktop 安装包，也不证明原生窗口/真机验收通过。原生桌面需要 Rust MSVC/C++ Build Tools、WebView2、.NET SDK、Node 和 pnpm。

WGC helper 的源码构建入口，在仓库根目录运行：

```powershell
dotnet publish new_tool/computer-control/Windows-MCP/native/wgc-helper/TryloWgcHelper.csproj -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
```

随后分别按锁文件安装 desktop、desktop-services 和 CLI 依赖，准备仓库工具，再从 desktop 目录运行：

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd build:bundle
pnpm.cmd tauri:build
```

`build:bundle` 负责服务宿主、桌宠、Node 和资源准备，`tauri:build` 的 beforeBuild 会再次调用该入口。CLI staging 必须已有 CLI 构建结果与依赖；没有自动安装行为。原生 WGC 摘要、固定 Node 发行输入、完整许可证组装及整包干净克隆验收仍需独立关闭，不能把这套入口说明当作整包验收结论。

本轮排查依据公开构建脚本和固定 manifest；纯 TypeScript 门禁、真实 ConPTY、真实模型与原生桌面属于不同层次的证据。
