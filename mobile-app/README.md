# Trylo Code

Trylo 的手机 App。首次打开进入任务与会话首页，可直接选择「在手机上聊聊」或「连接我的电脑」。底部使用「首页 / 会话 / 待处理 / 设备」导航。电脑会话默认展示对话正文，可展开执行过程、结果及团队成员；Code / Work 使用同一套呈现与审批入口。

1. **聊天**：手机直连模型服务商，像豆包一样随时聊天。支持豆包（火山方舟）、DeepSeek、通义千问、Kimi、SiliconFlow、OpenAI、Anthropic 以及任意 OpenAI 兼容的自定义接口；流式输出、Markdown/代码块渲染；会话记录只保存在本机，API Key 存在 Android Keystore。
2. **远程控制**：连接电脑端 `remote-gateway`，实时查看任务状态、远程发消息（可指定 Code / Work 通道）、查看 Work 产物（只读）、审批敏感操作。未配对时可进入演示模式。猫箱页已下线：新版电脑端不再提供该能力。

两部分互不依赖：不扫码配对电脑，也能正常使用直连聊天。

1.5.1 修复连接状态：未配对 / 演示内容明确显示「未配对」，不显示电脑在线、会话已同步，也不允许发送远程操作。电脑服务停止时真实连接仍按离线和重连流程处理。此版本包含 2026-10-15 接线修复，需要配套更新 Desktop 与 Service Host；本机回归不等同于真机扫码及外网隧道验收。

## 技术栈

- Ionic React 8（MIT）
- Capacitor 8（启用 CapacitorHttp 原生代理，绕开 WebView CORS）
- Vite + TypeScript
- `@aparajita/capacitor-secure-storage`（MIT，Android Keystore）

## 源码结构

```text
src/
  App.tsx              外壳、连接生命周期、配对与设置、产物预览
  remote/              双模式工作台、会话列表、共用审批与逐项工具记录
  MobileNavigation.tsx 历史导航组件（当前入口由 remote/ 与 DirectChatView 持有）
  RemoteEventStream.tsx Desktop 执行状态、可展开的思考 / 工具输入与结果
  DirectChatView.tsx   直连聊天界面、会话抽屉、模型设置
  directChat.ts        提供商预设、配置/会话存储、SSE 流式请求
  gateway.ts           远程控制 Gateway 客户端（WebSocket + REST，含 Code/Work 通道）
  remoteCache.ts       远程会话只读缓存（离线展位，服务端仍是唯一权威）
  ui.tsx               两部分共用的 BrandMark、Markdown 渲染、空状态
  theme.css            全局样式
  refresh.css          1.4.0 简洁视觉、品牌金色与系统浅 / 深色适配
```

## 本地运行

```powershell
npm.cmd install
npm.cmd run dev
```

正式版打包（会复用 `.trylo/android-signing` 中的私有签名身份）：

```powershell
npm.cmd run android:release
```

首次执行会生成独立的正式签名和本机恢复文件。两者不会进入 Git，但必须一起离线备份；后续公开更新必须使用同一签名，否则 Android 无法覆盖安装。

如果工程路径包含 `%` 等特殊字符，先执行 `npm.cmd run build`，再使用 `npm.cmd run preview`。

## 使用直连聊天

1. 在首页选择「在手机上聊聊」，按引导连接自己的模型服务商。已有配置可直接继续聊天；顶栏返回键回到首页。
2. 首次使用点「打开模型设置」，选择服务商（或填自定义 OpenAI 兼容地址），填入模型名和 API Key。
3. 回到聊天页直接发消息即可。会话自动保存到本机，可在左上角抽屉里新建、重命名、删除。

每个服务商的 API Key 分别由 Android Keystore 保护；服务商地址、模型名、系统提示词和会话正文等非敏感数据存在 App 私有本地存储，并已禁止系统云备份与设备迁移。请求从手机直接发到服务商，不经过电脑。内置服务商地址固定；自定义接口只接受不含凭据、查询参数或片段的 HTTPS 地址。

## 连接电脑（远程控制）

1. 在 Trylo Desktop 打开「手机扫码配对」，启用远程连接并取得 HTTPS 配对二维码。
2. 在 App 首页选择「连接我的电脑」，扫描二维码或粘贴配对数据；也可从「设备 → 扫码连接电脑」进入。
3. 从「设备 → 切换项目」选择项目，在会话列表恢复历史；右上角「+」新建真实 Desktop 的 Code / Work 会话。
4. 会话内切换对话 / 过程模式；待审批提示主动打开底部面板，显示真实操作、项目、目标、工具与单次授权范围。可从会话右上角停止当前任务。
5. 结果入口显示当前项目产物，保留原有 MIME 类型感知预览。消息保留 Markdown、代码、表格与附件能力。

两种模式读取同一份电脑端消息，不重复请求任务。模式选择保存在本机；草稿、工具展开状态和阅读位置在当前运行中保留，草稿按电脑 / 项目 / 会话隔离。不会把电脑未提供的思考内容补成推测。

首页连接手机聊天与电脑工作台；底部导航进入会话、待处理与设备，电脑会话中可查看结果。切换模块保留手机聊天的生成与草稿，也保留远程草稿。项目 / 会话选择与新建共用串行入口：请求开始即停用旧连接的写操作及回调，完成后同步完整快照再恢复。项目列表读取不能更改当前选择。离线保留当前会话，冷启动缓存同时恢复其项目与会话身份；空快照会更新为空缓存。

本机接线回归（无需真机或外部服务）：

```powershell
npm.cmd run test:remote
npm.cmd run test:remote:ui
```

界面回归使用同仓库 `desktop/node_modules` 中已有的 Vitest / jsdom，需先安装 Desktop 开发依赖。它挂载真实 App、导航与工作台组件，替换 Ionic 原生外壳和 Gateway 边界以注入延迟 / 失败；连接回归另以生产 Gateway 实现与合成 authority 验证本机 HTTP / WebSocket。这两类测试不等同于真机联机验收。2026-10-15 接线修复当时仅更新源码和 web 产物；1.5.1 APK 已包含这些修复及本轮连接状态修复，并通过签名与 APK 内资源一致性检查。

本次会话创建与完整事件投影需要配套更新 Desktop 和 Desktop Service Host。旧版电脑仍可显示其提供的状态，无法新建会话时会显示接口错误。

主要接口：

```text
GET /v1/snapshot
POST /v1/socket-ticket
WS /v1/events
POST /v1/chat/messages        # body 可带 surface: 'code' | 'work'
POST /v1/sessions             # 由 Desktop 创建，body: { surface }
POST /v1/sessions/:id/select
POST /v1/tasks/current/cancel
POST /v1/permissions/:id/decision
```

数据类型与通道定义位于 `src/gateway.ts`。远程会话以电脑端为准；手机另有一份只读缓存（`src/remoteCache.ts`），仅用于离线时展示，不回写。

连接先订阅 Gateway，再独立读取快照，不依赖历史接口成功。只有收到实时连接的首份完整快照后才开放远程操作；网络恢复或 App 返回前台时重新取得一次性连接票据并同步。每 25 秒检查一次可达性，忽略旧连接和迟到读取，离线缓存按电脑身份隔离。新配对先验证快照与电脑身份，再保存密钥；Desktop 未配置可供手机访问的 HTTPS 地址时不生成配对码。

2026-10-15 的独立设计预览仍可运行 `npm.cmd run preview:remote` 或 `npm.cmd run preview:remote:v2`。它们使用真实 Gateway 和本机合成 Desktop authority，不执行模型任务或命令，不读取已保存的配对。正式入口已接入双模式 UI；设计预览本身不参与 APK 构建。详情见 `preview/README.md` 和 `preview/v2/README.md`。

思考、工具调用、输出和失败 / 中断状态来自 Desktop 的统一事件流。没有有效耗时时显示「耗时未知」；结束后冻结计时。Work 使用 Desktop 现有 Work CLI 入口，产物读取来自当前项目 `.trylo/out`。此远程入口不自动启用屏幕控制权限。

## 本机页面验收

`desktop-services/tests/fixtures/mobile-ui-gateway.cjs` 以真实 Gateway 和内存 Desktop authority 提供明确标记的合成验收数据，不调用模型或执行命令。启动后将 Vite 的 `VITE_GATEWAY_URL` 指向其本机地址，`VITE_GATEWAY_DEMO=false`，测试 token 见该 fixture；这些变量只用于开发预览，不写入正式安装包。

会话 / 事件接口回归：`node --test tests/services/remote-gateway-events.test.mjs tests/services/remote-gateway-artifacts.test.mjs`（在 `desktop-services` 目录）。Desktop 投影与路由回归见 `desktop/src/remote/*.test.ts`。

## Android

安装 Android Studio/JDK 后：

```powershell
npm.cmd run build
npm.cmd run cap:sync
npm.cmd run android:open
```

本仓库已生成 `android/` 工程，不需要再次执行 `cap add android`。构建需要 Android Studio 自带的现代 JDK；系统中的 Java 8 不够。


## 团队与子智能体

在电脑会话输入框选择协作方式：单人，或 Desktop 提供的团队模板。选择模板只配置下一次发送；发送目标后，沿用电脑版的 Team Access、冻结配置与执行权限。电脑版需开启团队协作；旧版 Desktop 未提供此能力时，手机会说明开启条件。

Code / Work 的「成员」入口共用任务、进度、回复及多轮详情。续跑成员沿用 Desktop 已归并的稳定记录，重新连接恢复完整状态；离线缓存仅供阅读，不执行发送或审批。设计与验证边界见 [导航与协作说明](docs/mobile-navigation-and-collaboration.md)。
