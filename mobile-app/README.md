# Trylo Code

Trylo 的手机 App，集合两个独立功能，顶部用「聊天 / 远程」分段切换：

1. **聊天**：手机直连模型服务商，像豆包一样随时聊天。支持豆包（火山方舟）、DeepSeek、通义千问、Kimi、SiliconFlow、OpenAI、Anthropic 以及任意 OpenAI 兼容的自定义接口；流式输出、Markdown/代码块渲染；会话记录只保存在本机，API Key 存在 Android Keystore。
2. **远程控制**：连接电脑端 `remote-gateway`，实时查看任务状态、远程发消息（可指定 Code / Work 通道）、查看 Work 产物（只读）、审批敏感操作。未配对时可进入演示模式。猫箱页已下线：新版电脑端不再提供该能力。

两部分互不依赖：不扫码配对电脑，也能正常使用直连聊天。

## 技术栈

- Ionic React 8（MIT）
- Capacitor 8（启用 CapacitorHttp 原生代理，绕开 WebView CORS）
- Vite + TypeScript
- `@aparajita/capacitor-secure-storage`（MIT，Android Keystore）

## 源码结构

```text
src/
  App.tsx              外壳：两大功能区分段切换；远程控制的全部页面
  DirectChatView.tsx   直连聊天界面、会话抽屉、模型设置
  directChat.ts        提供商预设、配置/会话存储、SSE 流式请求
  gateway.ts           远程控制 Gateway 客户端（WebSocket + REST，含 Code/Work 通道）
  remoteCache.ts       远程会话只读缓存（离线展位，服务端仍是唯一权威）
  ui.tsx               两部分共用的 BrandMark、Markdown 渲染、空状态
  theme.css            全局样式
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

1. 打开 App，切到「聊天」。
2. 首次使用点「打开模型设置」，选择服务商（或填自定义 OpenAI 兼容地址），填入模型名和 API Key。
3. 回到聊天页直接发消息即可。会话自动保存到本机，可在左上角抽屉里新建、重命名、删除。

每个服务商的 API Key 分别由 Android Keystore 保护；服务商地址、模型名、系统提示词和会话正文等非敏感数据存在 App 私有本地存储，并已禁止系统云备份与设备迁移。请求从手机直接发到服务商，不经过电脑。内置服务商地址固定；自定义接口只接受不含凭据、查询参数或片段的 HTTPS 地址。

## 连接电脑（远程控制）

1. 在 VS Code 设置中启用 `tryloCode.remote.enabled`。
2. 启动 Cloudflare Tunnel，把 HTTPS 地址填入 `tryloCode.remote.publicUrl`。
3. 运行命令 `Trylo Code: Copy Remote Pairing Data`。
4. 切到「远程」，点右上角扫码按钮扫描电脑端配对二维码。

主要接口：

```text
GET /v1/snapshot
POST /v1/socket-ticket
WS /v1/events
POST /v1/chat/messages        # body 可带 surface: 'code' | 'work'
POST /v1/tasks/current/cancel
POST /v1/permissions/:id/decision
```

数据类型与通道定义位于 `src/gateway.ts`。远程会话以电脑端为准；手机另有一份只读缓存（`src/remoteCache.ts`），仅用于离线时展示，不回写。

## Android

安装 Android Studio/JDK 后：

```powershell
npm.cmd run build
npm.cmd run cap:sync
npm.cmd run android:open
```

本仓库已生成 `android/` 工程，不需要再次执行 `cap add android`。构建需要 Android Studio 自带的现代 JDK；系统中的 Java 8 不够。
