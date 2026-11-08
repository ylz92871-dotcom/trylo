# 对话书架

2026-11-08 已按用户批准的 edge-layout 预览接入 Desktop 源码。保留原单 U 线条书脊、直线抽出及向上展开的动画，以及先显示可读内容的轻微虚化过渡。

## 使用

对话至少包含两次用户提问时，左侧边缘显示书架入口。点击展开，移动鼠标查看问题和对应答复摘要，点击书籍或预览定位原始提问。当前阅读位置使用金色标记；悬停不会修改实际阅读位置。

每屏最多 72 本，实际数量随视口高度计算；滚轮、上下按钮或键盘可访问其余提问，不截断历史。方向键逐本移动，Home / End 到达整份对话的首尾，Enter 定位，Escape 或点击外侧收起。窄窗口与宽窗口使用同一套直线抽出、书页展开和即时可读过渡。侧边空间不足时，仅在使用书架期间临时覆盖正文，不预留顶部栏或压缩对话宽度。系统开启减弱动画时仍遵循该偏好。空对话和单次提问不显示入口。

## 所有权

`src/components/chat/conversation-bookshelf/` 是唯一生产实现，原型仅为历史设计证据，不是运行依赖。`entries.ts` 从原消息只读生成问题索引，以稳定消息 ID 导航；带 turnId 的迟到答复只更新对应提问，旧消息按原先顺序归属。

`ConversationBookshelf` 将真实视口几何交给本地 view，并在卸载时清理观察器和动画。view 只持有临时展开、分页和指向状态，不存储另一份会话。`shelf-layout`、`shelf-input`、`book-motion` 与 `book-preview-ink` 分别处理几何、输入、动画及可读文字。

Code / Work 的 `useConversationNavigation` 使用 MessageList 已有的显示投影、Virtuoso 和 follow controller。跳转暂停自动跟随；后续流式输出不会夺回历史阅读位置。虚拟目标的后续挂载通过实际 DOM 变化处理，无持续轮询。团队事件流共享同一视图，保留自己的非虚拟滚动及跟随控制器，且只索引当前运行内实际显示的提问。

样式由 `src/index.css` 引入，遵循现有主题。外层 MessageList 不滚动，原 Virtuoso 仍为唯一滚动容器，避免动画的可视边界制造第二条滚动条。没有新增依赖、IPC、存储字段或权限机制。

## 验证边界

定向测试检查消息归属、Code / Work 的历史定位、流式跟随、会话重挂载和既有团队呈现。真实浏览器验收使用生产 AgentConversationSurface、MessageList、Virtuoso、TeamEventFeed 和合成消息，覆盖 128 次提问、快速扫描、72 本容量、深浅主题、侧栏及窄窗口、减弱动画和空会话。

原始结果、截图、命令和自查记录在 [`_workspace/tasks/conversation-bookshelf-integration-20261108/`](../../_workspace/tasks/conversation-bookshelf-integration-20261108/)。浏览器验收不代表已测试原生安装包、IPC 或真实模型执行；这些边界未改动。

2026-11-08 小窗动画一致性修正与复核见[验收记录](validation/2026-11-08-pet-toggle-bookshelf-motion.md)。
