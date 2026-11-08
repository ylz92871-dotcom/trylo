# 搭建过程预览：模型、Three.js 场景与浏览器

状态：**待审；实现、生产构建、独立真实渲染验证及当前开发服务采用完成**。日期：2026-11-08。原生 Desktop/WebView2 视觉操作和安装包尚不能据此视为完成验收。

## 目的与边界

统一目标是在搭建过程中持续呈现可观察的阶段结果，而非仅在任务结束时显示成品。原有文档、图片和交互网页预览继续保留；模型/CAD 文件查看与可运行 Three.js 场景是并行的呈现路径，不互相替代。

| 内容 | 既有或本轮呈现入口 | 过程反馈 |
| --- | --- | --- |
| 文档、图片、表格、PDF 等产物 | 原成果入口、FilePeek 和格式 renderer | 继续沿用各格式读取、重载、转换及失败恢复合同，不改变文件和成果权威。 |
| 模型/CAD 文件 | 内置四工具、Agent 3D 工作区和同一 ModelPreview | 模型写入或资源变化后重读，保留镜头，以文件 revision 和 renderer 加载 version 核对图像。 |
| Three.js/HTML 运行场景 | 项目的本地页面或开发服务，加既有浏览器工具和 BrowserToolSidebar | 运行灯光、材质、动画及交互；观察实际网页、图像、控制台和网络状态，按项目自身的更新机制迭代。 |

Agent 使用现有写文件、建模或导出工具生成项目中的模型，再打开同一份文件、调整视角并取得真实渲染图像，以检查结果和继续修改。用户在聊天旁的 3D 工作区检查同一场景，文件变化后继续保留当前观察角度。

项目文件是权威来源。工作区没有独立的场景编辑数据库；相机、线框和展开状态属于临时查看状态。预览工具不创建或修改模型、不执行任意脚本，也不启动另一套任务循环。模型生成、文件写入及外部建模工具继续接受其各自的授权和生命周期管理。

当前复用正式 `ModelPreview` 的 Three.js 解析：STL、OBJ、GLB、glTF、3MF，以及经 OCCT Worker 转网格的 STEP/STP、IGES/IGS、BREP/BRP。支持格式由前端格式目录及服务合同分别验证，不能扩大表述为任意 3D 工程文件均可打开；例如 `.blend`、FreeCAD 工程和专有 CAD 工程仍需通过已有工具导出支持格式。伴随资源继续使用现有项目范围读取，不能从模型引用中取得任意外部文件或网络资源。

## 模型调用合同

内置 MCP 服务器名为 `trylo-preview`，工具包标识为 `model-preview`，通过现有 Profile 和权限链暴露四个工具。入口随 Service Host 提供，不要求用户另外下载安装一个 MCP 包。实际工具目录和工具可用性仍是每轮运行的权威。

| 工具短名 | CLI 完整名称 | 输入与结果 |
| --- | --- | --- |
| `preview_open` | `mcp__trylo-preview__preview_open` | `{ "path": ".trylo/out/model.glb" }`。路径相对当前项目，或为当前项目内的绝对路径。等待真实场景就绪后返回状态、文件版本及几何信息；重开同路径会更新文件和材质。 |
| `preview_view` | `mcp__trylo-preview__preview_view` | 可传 `preset`、`position`、`target`、`fit`、`wireframe`。预设为 `isometric`、`front`、`top`、`right`；坐标为三个有限数值。设置自定义镜头时同时传位置和目标。只改变查看状态。 |
| `preview_snapshot` | `mcp__trylo-preview__preview_snapshot` | `{}`。返回本场景真实渲染的 JPEG 图像，以及不含图像字节的路径、revision、renderer version、尺寸和相机等文本元数据。它不是桌面截图。 |
| `preview_close` | `mcp__trylo-preview__preview_close` | `{}`。关闭当前工具所属聊天的场景并释放其文件监听；不关闭其他聊天或其他应用。 |

典型顺序为：使用已授权工具写入模型 → `preview_open` → `preview_view` → `preview_snapshot` → 根据图像检查并修改源文件 → 等待更新后再次观察。修改几何体后不能只根据工具成功或文字统计宣称视觉正确；需要实际查看反馈图像。

示例视角输入：

```json
{"preset":"isometric","fit":true,"wireframe":false}
```

```json
{"position":[8,6,10],"target":[0,0,0]}
```

`preview_snapshot` 当前公共输入为空对象，不能自行添加截图尺寸、脚本或任意求值字段。渲染器内部的截图尺寸接口和 Service Host 帧边界由各自所有者管理。

## Three.js 运行场景与浏览器可视化

Three.js 场景以可运行网页呈现：项目代码建立几何体、材质、纹理、光照、相机和动画循环，网页还可以叠加控件、文字和音频。它不应被转成静态模型文件后声称所有运行行为仍然保留。Agent 使用项目现有工具维护代码和资源，通过已有命令权限启动或连接该项目自己的开发服务，再用浏览器工具打开准确地址。

| 操作 | 既有工具调用 | 判断依据 |
| --- | --- | --- |
| 打开运行场景 | `browser_navigate`，如 `{ "url": "http://127.0.0.1:5173/" }` | 地址由实际项目开发服务决定；示例端口不是固定产品协议。导航仍接受原浏览器权限、来源和会话约束。 |
| 回看真实画面 | `browser_take_screenshot`，如 `{ "type": "png", "scale": "css" }` | 省略 `filename`，确保标准 image content 回到模型；仅有写入文件的回执不等于模型已经看过画面。 |
| 检查运行错误 | `browser_console_messages`，必要时配合原网络检查工具 | 保留实际错误，修复代码后重新观察；不能用源码成功或空白截图替代运行结果。 |
| 持续更新 | 项目的 Vite HMR 或其现有刷新机制 | Trylo 不另建通用构建器、包管理器或场景存储。依赖、HMR 接受边界与状态恢复由项目维护。 |

Vite HMR 可以在既有网页实例内更新模块，但是否保留相机、动画和交互状态，取决于项目怎样划分模块以及是否正确接受更新。不能承诺任意 JavaScript 保存后都会自动保留镜头；完整页面重载和模块热更新也不能混称。本轮合成项目明确保留持久 renderer/camera，再替换场景内容，实际验证了保存模块后像素变化且文档与镜头实例不变。

浏览器工具调用时，既有工作台根据当前聊天的实际工具活动自动展示 BrowserToolSidebar。首个短操作可能在一次合并渲染中直接出现 completed，没有中间 active 状态；本轮补齐 `hasStarted` 的依赖监听，让这一真实开始事实也能触发首次展开。每轮一次、用户关闭后不反复打开、历史卡片不抢窗口、其他聊天不重定向当前画面的规则保留。

浏览器侧栏继续使用原生页面、标签页、地址、尺寸和用户接管状态，不以截图轮播代替可操作页面。用户关闭或切换面板只隐藏布局，不停止浏览器 MCP 任务或销毁标签页。模型截图是观察证据；侧栏显示的是同一受管浏览器会话的运行页面。导航、执行网页代码、交互和输出文件写入继续走原浏览器分类器及来源 lease，不能借内置文件预览的只读分类取得这些权限。

模型文件的 revision/version 与网页的文档、模块、渲染帧及会话生命周期属于不同所有者。网页如需提供业务 revision，应由项目明确暴露并验证；Trylo 不制造一个通用场景版本、第二套运行权威或隐藏重试循环来声称两条路径完全一致。

## 场景归属与生命周期

Service Host 将项目和聊天绑定为 scope，并为该 scope 生成私有回环能力入口；模型不能传入另一个聊天或项目来重定向请求。实际读取使用 canonical 项目路径，界面另保留原工作区身份，以正确匹配路径别名。回环入口只绑定 `127.0.0.1`，不接受网页 Origin，也不把入口 token 当成可公开的文件地址。

Desktop 的 `AgentModelPreviewBridge` 持有 scope 到场景的映射、renderer 绑定、就绪等待和指令归属。每条指令携带独立身份和 bridge 身份；相同 scope 的操作按所属队列处理。导航到其他聊天不会把原请求的回复交给新聊天，也不会仅因面板暂时隐藏而关闭健康的原场景。后台场景与当前可见场景保持不同实例；隐藏场景不接收用户点击和焦点。

关闭所属场景、取消调用、HTTP/MCP 断连、bridge 替换和宿主退出，均清理精确所属的等待。旧 bridge 或旧文件版本的迟到结果不能恢复已取消调用，不能冒充新场景的 ready 状态。渲染器卸载会取消旧加载、清理 RAF、ResizeObserver、OrbitControls、模型资源和 WebGL renderer；这些清理不停止其他 Agent 任务或应用进程。

## 文件更新、镜头与版本

Service Host 对实际文件进行范围和格式验证，并核对内容摘要；主文件或伴随模型资源事件推进不透明的 revision。renderer 使用外部 revision 触发重新读取、重新解析，并以内部递增 version 标识一次加载。两种版本各有用途，不能将 renderer 的次数当作文件内容摘要。

Agent 工作区还将主文件预期 SHA-256 交给 renderer：读取实际字节后、解析前再次核对，并将实际 `fileSignature` 随 ready 和截图返回。文件在服务核对与 renderer 读取之间改变时，只在实际出现新 SHA 的前提下更新版本并等待新场景，不给旧图改标签，不为同一错误盲重试。普通文件查看可不传预期摘要，保留原读取方式。Windows 默认 localhost 原点及开发 localhost 可使用 WebCrypto；缺少该能力时明确报错，不跳过校验。

每个 Service Host 使用不涉及授权 token 的独立版本代号，防止重启后相同主文件、不同贴图或缓冲复用旧 revision。桥重连后恢复该场景的监听；恢复失败返回真实 `autoRefresh:false`，不会因此拒绝模型文件读取。

同一路径及同一读取根的刷新保留相机位置、目标、上方向和线框。打开另一文件或切换读取根会清理之前的模型和查看状态。最新文件仍在加载、解析失败或被更新版本取代时，旧模型即使仍可见，也不能作为新版本的截图结果返回。

自动监听属于可降级能力：监听不可用时返回 `autoRefresh:false`，工作区保留手动重新加载入口，已授权的模型读取仍可继续。不能为了启用监听而放宽文件权限；不能将监听失败包装为模型文件不存在。快照前还会核查主文件，避免只依赖可能延后的文件事件。文件更新、重载与快照的竞态须以最新整合验收记录为准。

ready 状态提供真实几何摘要：`meshes` 是 Mesh 节点数，一个 InstancedMesh 容器计一个节点；`vertices` 和 `triangles` 对每次 Mesh 出现累计完整几何元素，并乘实例数量。索引几何使用 index 数量，非索引几何使用 position 数量。该统计不按 drawRange、材质或可见性裁减，不能当作实际 GPU draw-call 数量。bounds 是真实场景的世界坐标范围；界面尺寸标为“文件坐标单位”，不推测米、毫米等物理单位。loading/error 不借用上一个 ready 的摘要。

## 渲染反馈与传输

截图只抽取当前 renderer 的场景画布。顺序为：明确渲染当前帧 → 在独立画布铺与当前 viewport 一致的背景 → 复制 WebGL 图像 → 编码 JPEG。这样不依赖上一次 RAF 的绘制缓冲，也不会让透明背景在 JPEG 中变成另一种黑底。独立画布用完释放，截图尺寸处理不改变用户当前 viewport 尺寸。

默认保持宽高比、最长边不超过 1024、JPEG quality 为 0.85。返回元数据包含文件 revision 和 renderer version；Service Host 继续核验所属路径、当前版本及有效的 JPEG 数据。MCP 将图像作为标准 image content 返回，文本元数据不重复嵌入 data URL。

Service Host 的单帧上限仍为 **2 MiB**，需要计入 JSON、base64 和协议包装；这不是 2 MiB 原始图片额度。超界返回精确的普通工具错误，不能截断字节、伪造成功、扩大公共帧上限，或把旧的小图标成新版本。后续恢复如需降低编码尺寸，应由截图及协议所有者显式处理，不能向当前无尺寸参数的公共工具添加未声明字段。

## 工作区布局

正式入口由 App 的既有宿主和项目/聊天身份组成 `AgentModelPreviewWorkspace`，通过 AppShell 的工作区 dock 展示。场景是主要工作区域，文件身份和同步状态紧邻场景；模型统计和文件坐标尺寸放在可折叠信息区。沿用 Trylo 的主题、分隔线、字体及现有视角控件。

用户可旋转、平移、缩放、取景、切换预设和线框，也可手动重载、放大或关闭场景；展开后 Escape 返回。工作区的可见性与场景生命周期分开，切换聊天不应重置后台场景。普通文件预览继续共用同一格式解析器；Agent 工作区增加的是版本、控制、反馈和所属关系接线。

模型工作区与浏览器可视化沿用同一 AppShell 的 dock 与可见性接线；选择面板不构成新的任务取消权威。文档/成果预览继续保留原入口。显示状态不得代替 Service Host 的实际连接、加载和接管事实。

## 权限、取消与错误

本能力属于**项目内只读场景观察**。现有模式传入每轮权限快照，再由已激活工具包的精确工具分类器处理；不建立独立审批权威。

| 每轮模式 | 本能力的既有分类 | 保留的边界 |
| --- | --- | --- |
| `read_only` | 项目内观察为 read / auto_allow | 不授予创建、修改模型或调用写入工具的权限。 |
| `ask` | 已知的项目内观察为 read / auto_allow | 其他操作的询问和明确拒绝保持原有规则。 |
| `workspace_write` | 项目内观察为 read / auto_allow | 写入仍由各写工具及项目范围管理。 |
| `unrestricted` | 分类器为 read / auto_allow，最终沿既有完全自动策略 | 预览仍拒绝项目外路径；模式不会把它变成任意文件读取器或取得写入接口。 |

路径的词法预检不能代替服务端 realpath 检查。目录穿越、跨盘/外部路径、指向项目外的链接、未知工具和未激活包不能借预览获得自动批准。用户禁用工具和原有明确拒绝继续生效。模型伴随资源沿用既有 `readPreviewBinary` / scoped resource 权限；预览不取得屏幕、鼠标、键盘、Shell、写文件或任意网页求值能力。

普通文件缺失、格式/参数错误、材质资源失败、权限拒绝、bridge 不可用和超大反馈均作为带真实原因的工具失败返回模型。MCP 返回 `isError:true`，让既有 Agent 循环选择允许的恢复方式或向用户解释，不能只刷 warning 然后截断对话，也不能用空白图像伪装完成。工具取消精确清理该调用；用户取消整个任务时，仍由原任务取消权威终止，不为了收尾再次请求模型。

## 维护归属

| 边界 | 维护入口 |
| --- | --- |
| 四工具合同、scope 与输入验证 | `desktop-services/src/tooling/model-preview-contract.mjs` |
| 文件身份、监听、私有回环入口、指令/结果核验 | `model-preview-service.mjs`、`model-preview-watch.mjs` |
| MCP 图像/文本反馈与取消 | `model-preview-mcp.mjs` |
| Profile 注入和健康投影 | 现有 `tool-profile-service.mjs`、tooling composition、`host.mjs` |
| 每轮权限与精确工具分类 | `src/tooling/classifiers/model-preview-classifier.ts` 及现有 router |
| 场景队列、版本等待、导航归属、宿主接线 | `src/preview/agent-model-preview-bridge.ts`、`use-agent-model-preview.ts` |
| dock 和模型信息 | `src/components/preview/AgentModelPreviewWorkspace.tsx` |
| 浏览器首次工具展开与共享工作台生命周期 | `src/tooling/use-tool-workbench-lifecycle.ts`、既有 AppShell 接线 |
| 浏览器运行页面、截图、错误和用户接管 | 既有 `use-browser-preview.ts`、BrowserToolSidebar、`native-browser-service.mjs` 与 `native-browser-mcp.mjs` |
| 查看器控制合同与加载生命周期 | `ModelPreview.tsx`、`modelPreviewController.ts`、`useModelPreview.ts` |
| Three 解析、资源释放、相机、几何事实和截图 | `modelScene.ts`、`modelViewer.ts`、`modelSceneSummary.ts`、`modelViewportBackground.ts` |

修复应留在对应所有者，不向 App 累加预览业务，也不为一次读取失败创建第二套 runner、缓存或权限系统。变更工具名、格式、scene 统计语义、版本字段或帧格式时，同时核对服务、renderer、MCP、分类器和相关合同测试。

## 成熟参考

本轮参考用于确定工作区行为；未引入第三方编辑器运行时、云项目、账户或新依赖。研究方向和已核对资料见 [本轮研究记录](../../../_workspace/tasks/3d-preview-implementation-20261108/research-direction.md)。

- [PlayCanvas Editor interface](https://developer.playcanvas.com/user-manual/editor/interface/) 与 [viewport](https://developer.playcanvas.com/user-manual/editor/interface/viewport/)：以场景为主要工作区域，将身份、检查和取景放在邻近位置。
- [PlayCanvas MCP Server](https://developer.playcanvas.com/user-manual/editor/mcp-server/)：保持正确项目和会话，先观察、再变更、再检查结果；Trylo 继续沿用自己的文件和授权所有者。
- [Viser camera handles](https://viser.studio/main/api/handles/camera_handles/)：将相机和实际渲染反馈接入程序调用，明确区分当前观察角度与重置配置。
- [model-viewer staging and cameras](https://modelviewer.dev/examples/stagingandcameras/)：显式相机、目标和惯常的平移/缩放/重新取景行为。

## 分层验收与待审项

原始日志、开始快照、scoped diff 和哈希均在 [本轮任务目录](../../../_workspace/tasks/3d-preview-implementation-20261108/)。正式文档不复制会话 token、用户项目路径、原始模型、截图 data URL 或私密运行记录。

| 层次 | 当前证据 | 结论边界 |
| --- | --- | --- |
| renderer 与既有几何/资源合同 | [renderer-final-tests.log](../../../_workspace/tasks/3d-preview-implementation-20261108/renderer-final-tests.log)，**14/14**；[renderer review](../../../_workspace/tasks/3d-preview-implementation-20261108/renderer-review.md) | 包含真实 Three 几何计算；控制器测试替身不证明实际 GPU 像素。 |
| 项目网页静态 3D 资源 | [assets-green-local-http-tests.log](../../../_workspace/tasks/3d-preview-implementation-20261108/assets-green-local-http-tests.log)，**10/10**；[assets review](../../../_workspace/tasks/3d-preview-implementation-20261108/assets-review.md) | 真实本地 HTTP 字节、MIME、HEAD 和范围拒绝；不单独证明模型能渲染。 |
| Desktop 整合定向合同 | [desktop-final-affected-tests.log](../../../_workspace/tasks/3d-preview-implementation-20261108/desktop-final-affected-tests.log)，**63/63** | 覆盖本轮 bridge、权限、renderer、工作台和浏览器控制等受影响检查；不等于全仓回归。 |
| 浏览器短操作首次展开 | [workbench-red.log](../../../_workspace/tasks/3d-preview-implementation-20261108/browser-visualization/workbench-red.log) 原六项中四过、两项新增回归失败；[workbench-green.log](../../../_workspace/tasks/3d-preview-implementation-20261108/browser-visualization/workbench-green.log) 三文件 **21/21** | 验证 hasStarted 合并渲染触发、关闭/历史范围、现有浏览器 scope/epoch 与接管；日志与 Desktop 63 项存在重叠，不能相加作为独立总数。 |
| Service/MCP/scoped lifecycle | [preview-services-final.log](../../../_workspace/tasks/3d-preview-implementation-20261108/service-review-resumed/preview-services-final.log)，**16/16**；[服务复核](../../../_workspace/tasks/3d-preview-implementation-20261108/service-review-resumed/review.md) | 本地回环、模拟 renderer 与真实监听调度合同；覆盖修复后的更新竞态和重连监听，不单独证明像素。 |
| 实际 headless WebGL + 正式工作区 + 实际 Service/MCP | [模型渲染 proof](../../../_workspace/tasks/3d-preview-implementation-20261108/webgl-acceptance/run-1794138535715/proof.json)，四组检查通过 | 实际打开、镜头和截图、文件变化保留视角、聊天后台场景回传、关闭与窄屏；属于独立 headless 渲染，不是原生窗口验收。 |
| 实际 Three.js + Vite HMR + 正式浏览器 MCP | [Three.js runtime proof](../../../_workspace/tasks/3d-preview-implementation-20261108/three-runtime/run-1794138911454/proof.json)，四组检查通过 | 实际几何/纹理/光照/动画；保存模块后像素变化、镜头和文档保留；运行错误到工具反馈及修复；受管会话的操作状态。画面已检查，但不外推任意用户项目都具有相同 HMR 保留策略。 |
| 完整 Desktop 类型检查 | [desktop-typecheck-resumed.log](../../../_workspace/tasks/3d-preview-implementation-20261108/desktop-typecheck-resumed.log) 及[退出收据](../../../_workspace/tasks/3d-preview-implementation-20261108/desktop-typecheck-resumed-exit.json)，退出 **0** | 正式 Desktop tsconfig 完整检查通过；不代替生产构建及运行副本字节核对。 |
| 既有独立 Chrome fixture 失败 | [chrome-new-page-baseline-receipt.json](../../../_workspace/tasks/3d-preview-implementation-20261108/chrome-new-page-baseline-receipt.json) 旧/新 router 均将空参数 `new_page` 判为 `invalid_navigation_argument` | 保留已知一项失败；本轮不放宽浏览器参数/权限来吞掉，也不称所有既有测试均通过。 |
| 最终 renderer 字节身份 | [renderer-byte-identity/review.md](../../../_workspace/tasks/3d-preview-implementation-20261108/renderer-byte-identity/review.md)，11/11；[服务最终版本检查](../../../_workspace/tasks/3d-preview-implementation-20261108/service-review-resumed/version-seam-final-services.log)，19/19 | 实际读取摘要不符不解析/不截图；只有新的真实 SHA 才恢复；普通预览兼容。 |
| 最终 Desktop 受影响检查与类型 | [desktop-final-pinned-tests.log](../../../_workspace/tasks/3d-preview-implementation-20261108/desktop-final-pinned-tests.log)，12 文件 **68/68**；[最终完整类型检查收据](../../../_workspace/tasks/3d-preview-implementation-20261108/desktop-typecheck-pinned-final-exit.json)，退出 **0** | 包含最后的身份校验及既有共享预览/浏览器检查；不声称全仓测试全绿。 |
| 真实 AppShell 与模型工作区组合 | [最终组合 proof](../../../_workspace/tasks/3d-preview-implementation-20261108/webgl-acceptance/run-1794139998415/proof.json)，**7 组通过** | 自动开合、收起保持、浏览器互斥、放大退出、拖宽、窄窗、聊天后台截图；实际文件 SHA 与源码前后稳定。浏览器区域在此用例为壳层占位，运行网页由上述 Three.js 独立用例验证。 |
| 最终生产构建与输出 | [desktop-build-final.log](../../../_workspace/tasks/3d-preview-implementation-20261108/desktop-build-final.log) 及[退出收据](../../../_workspace/tasks/3d-preview-implementation-20261108/desktop-build-final-exit.json)均成功；[固定 Node 服务候选](../../../_workspace/tasks/3d-preview-implementation-20261108/service-candidate/run-1794139966131/receipt.json) 真实 MCP init/list 通过；[服务 dist 字节绑定](../../../_workspace/tasks/3d-preview-implementation-20261108/service-dist-publication.json) | 隔离产物及正式服务 dist 已核对，未覆盖原生资源以触发窗口重启；不属于安装包发布。首次前端输出目录 EPERM 保留在 `desktop-build-resumed.log`，未放宽权限或省略 CAD 资源。 |
| 当前开发入口 | [已提供模块](../../../_workspace/tasks/3d-preview-implementation-20261108/dev-served-modules.json)三项 HTTP 200；[安全切换前](../../../_workspace/tasks/3d-preview-implementation-20261108/runtime-service-update-before.json)和[采用收据](../../../_workspace/tasks/3d-preview-implementation-20261108/runtime-service-update-after.json)核对无活动任务后，仅刷新后台服务，新服务从源入口启动，原窗口进程保持 | 首次保护检查确实因活动任务拒绝刷新；等待任务结束后再切换，没有停止 CLI、重启窗口或触碰 WSL。属于模块/进程证据，不冒充在用户原生窗口代点验收。 |
| 原生 Desktop/WebView2、安装包 | **未据本轮证据完成验收** | headless WebGL、进程启动和单元测试均不替代这两层。 |

保留原始红例和环境失败，不覆写为成功。初始 headless 模型验收的错误成功字段断言、更新版本竞态，以及 Three.js 初始运行失败，均保留在任务目录，不能以最终绿例覆盖其原始记录。本轮没有使用电脑控制工具、操作用户桌面或发送付费模型调用。

回滚只针对本轮明确的 scoped hunks 和新增文件，先核对并发消费者及当前字节；不能 reset、清理用户状态或移除既有未提交修改。当前完整交付、采用边界与保留失败见 [delivery-summary.md](../../../_workspace/tasks/3d-preview-implementation-20261108/delivery-summary.md)。
