# 手机远程工作台预览 0.1

本轮约定：先修连接并给出呈现预览；正式事件 UI 与完整 Desktop 投影在用户确认后继续。

在 `D:\CC\trylo\mobile-app` 运行：

```powershell
npm.cmd run preview:remote
```

打开 http://127.0.0.1:4183/preview/index.html 。服务仅绑定本机回环地址，端口为 4183（页面）和 49414（Gateway）。退出终端任务即可停止本次启动的进程；不会启用公网隧道。预览代码未加入正式构建入口。

预览可操作：展开思考摘要与工具输入/结果、允许/拒绝合成审批、停止合成任务、新建/切换 Code 与 Work 会话、发送消息、模拟断线/恢复、桌面宽度下切换深浅色。

浏览器中的原 APP 与独立预览均使用 `src/gateway.ts` 和 `src/remoteConnection.ts`；后者经过本次连接修复。Gateway 是生产实现，Desktop authority、电脑名称、任务和审批都是合成数据。预览不会调用真实模型、执行命令、读取/保存用户的配对。

呈现方向：连接状态常驻；当前电脑/项目/会话可见；执行记录随对话按顺序出现；工具默认收起；审批紧邻当前任务且仅在同步后开放；断线保留记录，恢复后由电脑状态覆盖。

验证与证据：见 `D:\CC\trylo\Temp\mobile-remote-preview-20261015\acceptance.md`。

已知后续工作：Desktop Code 远程投影目前按整轮累积文本/思考，尚未完整使用 `blockId`；Work 全量事件、后台并发会话隔离和所有 Desktop 事件类型仍需后续核对与接入。此预览不代表这些能力已经完成。正式 UI、APK 和真机验收等待用户确认预览后继续。
