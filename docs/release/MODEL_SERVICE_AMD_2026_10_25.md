# AMD 免费池接入记录

2026-10-25。用户授权把 AMD API 加入免费池，收录全部模型，并明确要求每个获授权账号每天至少 1000 次。

后续双 API 分流与 Desktop 接线见 [最新验收记录](MODEL_SERVICE_DESKTOP_DUAL_AMD_2026_10_25.md)。以下保留首次单 API 发布时的状态。

## 已部署的行为

首尔账号服务已升级为 0.2.2，显式启用 AMD 适配器。复用已有账号、管理员会话、CSRF、SQLite 配额账本和服务部署链路，没有新增一套账号或向用户发放供应商密钥。

- [后台上游配置](https://trylocode.me/admin/#upstreams)可查看 AMD 免费池、单独更换密钥与同步目录；[用户授权](https://trylocode.me/admin/#modelGrants)分配账号、模型与额度。
- [个人模型页](https://trylocode.me/account/#models)显示自己的配额与模型能力。初始给既有 YLZ 管理员开通全部 15 个目录项；没有自动为所有注册用户添加授权。
- 每个获授权账号每天 1000 次，全部模型共享；按北京时间日历日重置。试运行共享池上限 100000 次/日、上游并发 2、每账号并发 1、全局并发 4，均是 Trylo 的限额，不代表 AMD 官方余额或限流规则。
- 凭据用 AES-256-GCM 加密存于私有数据库，认证数据绑定上游 ID、精确 API 地址与协议。主密钥为服务器私有数据目录中的 0600 文件；接口只返回配置状态。改变 API 地址后不能沿用密钥向新地址发请求。
- AMD 执行器固定访问 `https://developer.amd.com.cn/radeon/api/v1`，不跟随重定向。请求次数先原子预占，完整成功后结算 1 次；已发送但状态不确定的请求保留 1 次，不自动重放或转入付费池。
- 支持按明确上游 ID，或 `pool: free` 在当前账号获授权、已启用、凭据就绪且有余额的免费上游中选路。Coding Plan 执行器未开放，即使配置记录被启用也不会误转入付费上游。

## 15 个模型目录

声明支持聊天的 10 个：DeepSeek-V4.1-Flash、DeepSeek-V4-Flash、Gemma-4-31B-IT、GLM-5.3-Flash、MiMo-V2.6-Flash、MiniCPM5-2B、MiniCPM-V-4.7-1B、MiniCPM-V-4.7-35B-A3B、Qwen3.8-27B、Qwen3.8-Flash-Next。

专用目录项 5 个：Clef、d3、d3-flash（判别）、MinerU2.5-Pro（OCR）、OmniVoice（语音）。全部收录并保留能力元数据，但其专用调用入口尚未实现，不能伪装为聊天模型发到 Chat Completions。

目录的 `free` 与 cost 字段和用户给出的 UI 使用说明不一致，没有把它当作已确认的收费承诺；“免费池”指 Trylo 对获授权用户的服务分类。采用请求次数计量，不将 AMD 积分、货币或不一致的 total_tokens 统计混为一套配额。

## 实证与范围

55 项测试通过，包括密钥重启读取、篡改/地址绑定、账号隔离、CSRF、额度与并发、拒绝付费回退、分片 UTF-8/CRLF SSE、截断流保留用量、完整 HTTP 授权调用及新后台操作。原有账号与手机/桌面 relay 测试仍通过。

真实 AMD Qwen3.8-Flash-Next 在工作站和首尔各完成普通与流式调用。首尔实际流返回 31 个事件，账本两条均已结算、每条 1 次，YLZ 当时剩余 998/1000。没有据此宣称 10 个模型均逐一实测、真实视觉/工具能力通过、5 个专用入口完成或现有 Desktop 1.0.6 已接入平台模型。该安装包的 provider 选择仍需后续接线，直接配置的自定义 API 也不受平台配额控制。

公网已独立核对后台/个人页及三个脚本的实际摘要、五条受保护接口匿名 401、运行包与本机构建一致、主密钥权限 0600、加密记录、模型目录、两条实际账本和 relay 健康。浏览器工具被 Work 设置禁用，本轮没有实屏浏览器复查或截图；不将 jsdom 检查当作原生界面验收。

## 发布与恢复

发布目录：`/home/admin/trylo-accounts/release-amd-20261025T043301Z`；镜像：`trylo-relay:amd-2fc1649aee23`；归档 SHA-256：`2fc1649aee23860911a962928e27c83c5200802524ea60d2e8d6d20e4b424394`。账号身份、设备、会话、邀请码和全站限制在导入前后摘要一致，官网入口配置未变。

升级前私有备份：`/home/admin/trylo-accounts/backups/amd-20261025T043301Z`。导入后的 SQLite 一致性备份与配套主密钥另存于其中 `amd-configured/`，目录 0700、文件 0600，未下载到工作站。回滚应先核对当前 compose 哈希与部署记录匹配，再使用保留的旧 compose/镜像；不要删除数据卷或用旧 JSON 覆盖 SQLite。旧版本忽略新增模型凭据表，恢复旧运行时即停止统一调用。

源码归属：`remote-relay/src/model-service/`、现有 `console/admin/model-service/` 与 `console/user/app.js`。本轮脚本位于 `remote-relay/scripts/`；私有凭据不进入仓库。证据与初始源文件副本位于 `C:/work/demo-ws/output/amd-free-pool-20261025/`，未提交或推送。
