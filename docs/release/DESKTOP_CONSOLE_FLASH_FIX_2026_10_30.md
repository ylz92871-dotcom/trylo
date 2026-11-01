# Desktop 控制台闪窗修复收口

- 状态：已归档
- 阶段：Desktop 运行时修复与本地发行候选
- 负责人：Codex
- 最后更新：2026-10-30
- 依赖决策：保留现有权限与环境准备；用户使用电脑期间不操作界面，不运行安装器或真实 Desktop 界面。

## 结果

两条已确认路径均已修复，并生成本地 1.1.1 候选：

1. Git snapshot、diffStats、fileDiff 等后台 Rust 子进程统一使用 `CREATE_NO_WINDOW`。兼容入口一并补齐；CLI Git adapter 显式 `windowsHide: true`。
2. 便携包默认入口改为 Windows GUI 程序 `Start-Trylo.exe`，新 ZIP 不再包含 `Start-Trylo.cmd`。仓库旧 CMD 文件不作为新包入口。

GUI 启动器隐藏运行准备脚本，成功后才启动主 GUI。失败写 `Start-Trylo.log` 并显示正常错误提示。诊断参数 `--prepare-only` 不启动 Desktop 或错误对话框；`--no-error-dialog` 支持日志模式的进程验证。

准备脚本保留发行目录、组件和 reparse point 校验；whoami、icacls 等后代进程也明确隐藏并限时执行。实际测试发现旧脚本按管理员组成员身份选择 High，在实际 Medium token 下可能失败，现改为读取真实完整性 SID。Low 启动器明确失败，不申请提升权限或伪称准备成功。

## 交付

目录：`work/desktop-console-20261029/artifacts/`。

| 文件 | 字节数 | SHA256 |
| --- | --- | --- |
| Trylo_1.1.1_x64-setup.exe | 140907102 | `16662e37a19602d8db971b9a94ab26b4c9efad249f593d5742f6b31237737ae6` |
| Trylo-Desktop-1.1.1-windows-x64-portable-core.zip | 162716932 | `b9a2b6165b0f81196843b51e44906748aaa0ec4b983226c4f1cbf18226aa2f1b` |

两者是未签名的本地修复候选，未上传或替换官网/GitHub 文件。便携包完整解压后运行 **Start-Trylo.exe**。

候选在独立目录 `work/desktop-console-20261029/candidate-1.1.1/` 构建，冻结留存 1.1.0 发行目录的源码、前端与资源，仅叠加明确修复和候选版本元数据，没有吸收主库其他 Team/UI/学习控制面改动。公共工作区只读，未提交或推送源码。

CLI 只替换 Git runner 的 JS/declaration 并重算清单。旧 TS 的固定 TypeScript 转译结果先与冻结包原 JS 完全匹配，然后才转译修复版，避免把其他未提交 CLI 工作带入。没有新增产品依赖，已有 SBOM、许可证和固定 Node 保留。

## 验证

| 验证 | 结果 | 证据（本次 work 目录） |
| --- | --- | --- |
| GUI 启动器真实进程：准备/启动成功、失败禁止启动、嵌套 Low helper 修复、Low 启动器拒绝 | 4/4 | `portable-launcher-platform-formatted.log` |
| 标准/Tokio 后台命令与 CLI adapter 原生窗口属性 | 3/3，console=false / visible=false | `background-console-fixed-only.log` |
| Rust Git 功能与 2000 文件规模 | 上轮 18/18；生产源码未再变化 | `rust-git-tests-workspace-temp.log` |
| 对应冻结源的资源库存门禁 | 17/17 | `candidate-frozen-resource-inventory.log` |
| CLI 文件、依赖、固定 Node 批准/拒绝写入 | 2914 文件；批准后写入且 completed，拒绝不写入且 failed | `candidate-cli-verification-final.log` |
| 原生程序 | Release 编译通过；GUI 子系统；FileVersion/ProductVersion=1.1.1 | `candidate-1.1.1/tauri-console-fix-build.log` |
| ZIP CRC、入口与逐文件比对 | 4960 条目；4953 运行时文件 SHA256 匹配；2914 CLI 文件匹配清单；两个 GUI EXE；无 CMD | `portable-artifact-verification.json` |
| NSIS CRC 与解包比对 | CRC 通过；4955 个共同文件与 ZIP 的 SHA256 一致，含主程序和发行配置 | `installer-artifact-verification.json` |
| 真实解出便携包的启动准备及固定 Node 写入 | Low SID 4096 + EPERM → 准备 → Medium SID 8192 + 实际写入成功 | `extracted-startup-verification.json` |
| 新 Rust 启动器与范围内格式 | rustc -D warnings、rustfmt、diff --check 通过 | 构建脚本及最终检查 |

真实便携包只执行了 `--prepare-only` 和固定 Node，没有启动真实 Desktop。应用启动路径使用可观测、无控制台的进程夹具覆盖，不称为 Tauri/WebView2 界面验收。

原始可见控制台反例继续保留，没有在用户使用电脑时重跑。本轮一次早期失败夹具进入了错误提示分支，随后测试统一改为日志模式；最终验证没有再次打开提示窗口。

## 原始失败与边界

- 受限沙箱首次不能提高新测试文件的完整性标签（1299）；获批后仅在独立夹具中验证，未修改系统设置。
- 首次真实启动器测试发现管理员组与实际完整性级别不一致，保留 `portable-launcher-platform-unrestricted.log`；修复 SID 判定后最终 4/4。
- 拒绝写入本来返回 exit 1；初版探针错误地要求拒绝也 exit 0，已修正测试预期，没有改变 CLI 的失败合同。
- 首次资源检查把主库当前 Service Host 当成冻结候选基线，报告不一致。改用对应冻结源的库存门禁后 17/17，没有覆盖为主库其他工作。
- 原生编译后首次 NSIS 封装因受限环境不能访问下载主机失败；正常环境复用已有构建工具后封装成功。NSIS 重试的 marker 警告来自首次尝试已完成的 NSS 标记，实际检查确认只有一个 NSS，且两个包的主程序完全一致。项目未启用 updater 插件。

失败输出均保留。临时解包工具只用于读取包，来源/摘要在 `verification-tools/provenance.json`，未进入产品。

可读性与维护性自审通过：一个 GUI 启动所有者、一个隐藏且限时的原生命令执行函数；准备失败不能继续启动主程序。没有改变模型、账号、审批、学习或持久化合同。

完成范围是源码、本地 ZIP/NSIS 候选和后台进程/包内容验证。未执行安装向导、真实 Desktop 界面或真实 provider；未重跑全仓 CLI verify；范围外工作与格式问题未吸收进候选。线上仍为原发行。

回滚按本次源码清单撤销窗口构造、启动器与打包入口即可，原发行包保留，没有用户数据、设置迁移或发布操作需要恢复。
