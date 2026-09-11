# Trylo Remote Gateway

本模块运行在 VS Code 扩展进程内，只监听 `127.0.0.1`。Cloudflare Named Tunnel 将固定公网域名转发到本地端口，Gateway 自己负责设备认证与控制权限。

## 安全模型

- 256 位随机配对凭据，通过 VS Code SecretStorage 保存。
- HTTP 使用 `Authorization: Bearer <token>`。
- WebSocket 必须先用 Bearer Token 换取 30 秒、单次使用的连接票据。
- 服务默认只监听回环地址，不直接开放局域网或公网端口。
- 不向手机发送 API Key、模型凭据或完整工作区路径。

## Cloudflare Named Tunnel

正式入口固定为：

```text
https://remote.trylocode.me
```

Cloudflare 将该入口转发到：

```text
http://127.0.0.1:49380
```

插件默认使用 `tryloCode.remote.tunnelMode = named`。固定域名不会因 VS Code 重启、切换项目或重新扫码而变化。仅在临时排障时将模式切换为 `quick`，插件才会创建随机的 `*.trycloudflare.com` 地址。

## 接口

```text
GET  /health
GET  /v1/snapshot
POST /v1/socket-ticket
WS   /v1/events?ticket=<single-use-ticket>
GET  /v1/chat/history
POST /v1/chat/messages
GET  /v1/fun
GET  /v1/fun/:characterId/history
GET  /v1/fun/:characterId/memory
POST /v1/fun/:characterId/messages
POST /v1/fun/:characterId/speech
POST /v1/fun/:characterId/clear
POST /v1/fun/:characterId/cancel
POST /v1/tasks/current/cancel
POST /v1/permissions/:id/decision
```
