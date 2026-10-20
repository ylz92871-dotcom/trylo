# Windows 原生服务入口路径修复

2026-10-20。

原生 Desktop 的 Tauri 资源目录在 Windows 上可能使用 `\\?\D:\...` 扩展路径。
把这个路径直接作为 Node 24.14.1 的脚本参数，会在入口装载时触发
`EISDIR: illegal operation on a directory, lstat 'D:'`。Service Host 随即退出，
工具、手机连接和桌宠依赖的服务无法就绪；单独以普通路径测试服务却可以通过。

`node_runtime::node_script_argument` 仅把脚本入口的 VerbatimDisk / VerbatimUNC
还原为普通 Windows 绝对路径。Node 可执行文件的路径保持原样，其他设备命名空间
保持原样。Service Host 和独立 Work 后台共用该处理；CoWork 仍未随核心包提供。
此修复不改变权限模式、审批、沙箱或操作系统访问控制。

验证覆盖 14 项 Rust 路径/资源解析测试（含 5 项新增入口路径用例），以及实际
Windows GUI 父进程与随包 Node 的对照：原扩展脚本路径失败，经过产品函数处理后
同一份 Service Host 发出 ready。中文、空格、UNC 和设备路径边界也已覆盖。
原始失败记录保留。修复版制品及原生窗口验证另由发布记录说明。
