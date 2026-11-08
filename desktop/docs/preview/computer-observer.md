# 电脑观察窗

`ComputerPreviewWindow` 是电脑工具的只读观察窗口，由原生 `computer_preview` 宿主管理。主窗口发布快照，观察窗订阅；观察窗关闭不停止任务。它不持有工具执行、审批、接管或权限决策。

## 呈现合同

- 顶部单行并列显示工具动作、目标和画面连接状态，使用文本与弱色区分；不重复添加标题、副标题或动作卡片。失败原因允许顶部增高换行。画面断连不能被表述为工具失败，任务停止不能保留旧动作的执行动画。
- 主区域沿用 `PreviewImage` 的原图坐标、DPR 和缩放计算。此处使用其可选的底部工具栏；其他调用方默认仍在顶部。没有向观察窗提供 `onInput`。
- `ComputerPreviewFooter` 通过 `PreviewImage.renderToolbar` 复用原来的缩放工具栏，和历史入口共用底栏，只持有历史展开状态。`PreviewImage` 的既有 scope key 同时重置这一局部状态。历史在正常布局中展开，限高滚动，不覆盖截图。最小原生内容区 480 × 360 仍保留画面、缩放和历史入口。
- 等待、连接中、实时、保留画面、断连、失败和停止沿用宿主状态。失败原因允许换行，并在详情中保留完整内容。主题复用 Desktop tokens。
- 原生窗框、自动打开和焦点策略、订阅与清理、截图来源和捕获节奏保持原合同。

## 验证

组件检查：`node node_modules/vitest/vitest.mjs run src/components/chat/ComputerPreviewWindow.test.tsx src/components/chat/PreviewImage.test.tsx`。覆盖终态、断流、scope 切换、取消订阅、缩放和负屏幕坐标。

渲染检查：在 `desktop/` 执行 `node scripts/verify-computer-preview-ui.mjs`。它渲染生产组件，仅用 `testdata/computer-preview-acceptance/` 的合成画面和订阅通道，在独立无头浏览器验证八种状态、最小窗体、历史键盘展开、缩放与失败原因换行。原始输出进入仓库 `_workspace/`，不读取或操作用户桌面。

2026-11-08 用户要求进一步收敛为极简风格，当前以[极简修订记录](../../../_workspace/tasks/computer-preview-ui-20261108/minimal-refinement.md)为准。[前一版记录](../../../_workspace/tasks/computer-preview-ui-20261108/delivery.md)保留作为过程证据。无头通过不代表已在用户的原生窗口完成视觉验收。
