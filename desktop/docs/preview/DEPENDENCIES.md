# 预览依赖采用记录

## 独立 Office 页面引擎

用户于 2026-11-03 明确允许 LibreOffice 作为仓库 stars 门槛的例外，采用范围是可替换、独立管理的本地 Office 页面引擎和发行供给。该例外不适用于其他项目，也不授权其接管 Trylo 核心运行时。

- 项目由 The Document Foundation 治理，有独立发布、Windows x64 官方 MSI、版本归档、官方摘要/签名和安全公告渠道。代码有企业与社区贡献；不能用基金会名称或提交总量代替维护风险判断。依据：[基金会](https://www.documentfoundation.org/)、[下载](https://www.libreoffice.org/download/)、[系统要求](https://www.libreoffice.org/system-requirements/)、[安全公告](https://www.libreoffice.org/security/)。
- 当前锁定 26.8.2.2 / Windows x64，官方 MSI SHA256 和核心摘要见 `scripts/build/shared/preview/office-engine.lock.json`。以文件到 PDF 的进程边界接入，发布配置不依赖系统 Office。核心协议、CLI、学习和成果模型不依赖 LibreOffice 类型。
- 构建时 `supply-office-engine.ps1` 复用已验证资源，或获取固定官方 MSI、检查摘要/发布者、作管理镜像解包并应用固定精简配置。它不运行普通系统安装，不接管关联/用户配置；应用运行时不会下载引擎。
- 26.8.2.2 全量暂存为 19,417 文件 / 1,583,065,349 字节。六种 DOCX/XLSX/PPTX/DOC/XLS/PPT 的正式文件到 PDF 接口已真实通过，含项目范围、原件不变及作业清理；随后原始文件全量摘要仍匹配。页面数与末尾文字检查通过，并以 Poppler 检查中文、图片与图表页面。实际原生交互和安装验收仍未完成，不能继承旧版本或离线输出的结论。
- 许可由实际 `license.txt`、`LICENSE.html`、`NOTICE` 和对应源码供给承担，不能把整个分发包概括为单一许可。引擎和解码器的版本源码伴随包、原始构建脚本与摘要在发行工作目录保存，公共发行必须同步提供相应内容。
- 2026-11-10 瘦身配置 `headless-preview-zh-en-v1`：完整上游镜像的摘要仍独立固定；分发时使用 6,465 文件 / 661,169,972 字节的转换配置。保留转换二进制、格式过滤器、全部原有字体、CJK 数据和多语言断词词典；界面语言保留英文、简繁中文。移除拼写/同义词词库及其 XCU 注册、其他界面翻译、离线帮助、画廊、模板、额外图标主题、求解器和维基发布扩展。二进制不作修改；XCU 改动由随源码伴随包提供的 `office-runtime-profile.mjs` 重现。完整上游和精简分发各有固定清单摘要，运行时校验继续使用精简后的 pin，未放宽校验。六种 Office 格式的定向结果及安装包大小记录在 `docs/validation/2026-11-10-installer-slimming.md`。转换不是系统级沙箱，排版受字体与兼容性影响。

未采用的主要路径：ONLYOFFICE DocumentServer 需要完整服务栈及 AGPL/附加条款评估；DesktopEditors 是完整编辑器宿主；单纯 OOXML 前端渲染无法满足 Office 排版/图片/图表的统一预览。本次保留现有 OOXML 基础/表格数据视图作为明确标注的辅助视图。退出方案是替换文件到 PDF 提供器并继续使用已有 PDF 阅读器，成果存储和容器无需随引擎重构。

## 叶子格式提供器

UTIF 3.1.0、libheif-js 1.23.5、occt-import-js 0.0.23 仅作为图像或网格叶子提供器。输入为有界文件字节，输出为图像/三角网格；不运行工具、管理聊天、持久化任务或接管 UI 状态。它们不是额外获得 stars 例外的核心平台。

这些包装器维护集中、社区规模较小，不能按大型基金会项目假定成熟度。采用依据是与目标格式的直接契合、实际 TIFF/HEIC/STEP/IGES/BREP 解码样本、明确的关闭/超时边界及退出路径。新格式必须继续有真实文件与原生运行证据。DWG/SolidWorks 等仍不在解析范围。

- TIFF：[UTIF.js](https://github.com/photopea/UTIF.js)，MIT，原样 JS 与 pako/许可一起提供。
- HEIC：[libheif-js](https://github.com/catdad-experiments/libheif-js) 及其固定 [Emscripten 构建](https://github.com/catdad-experiments/libheif-emscripten/tree/v1.23.5)，LGPL-3.0 及附带依赖许可；固定 libheif 子模块 413e2a87e6a70b3eccc3a3adc5801179dd2d9e00、libde265 1.0.15、Emscripten 3.1.61 的原始构建配方。
- 通用 CAD：[occt-import-js](https://github.com/kovacsv/occt-import-js/tree/0.0.23)，LGPL-2.1；固定 OCCT 子模块 d2abb6d844231cb8f29be6894440874a4700e4a5（7.6.1）及其自身许可/例外，原始 Emscripten 3.1.69 构建配方。

原生端实际读取安装目录的 `preview/codecs` 文件，通过现有 asset 协议提供给独立 Worker；不会因外部文件缺失静默退回内嵌原版。按格式独立解析资源，某一提供器缺失不让其他格式一起失败。原样文件、许可证、替换说明和源代码伴随包的详细供给见 `codecs.md`。

## 媒体叶子服务

本轮采用独立 FFmpeg CLI + hls.js 缓冲，边界是只读文件描述符到 H.264/AAC 分段；不进入 CLI/学习/Agent 调度。hls.js 1.7.4 按实际 npm 包固定，Apache-2.0，延迟加载、不启动后台 Worker；UI 继续使用标准媒体控件。FFmpeg 自建 LGPL-2.1+ 共享变体与版本/摘要固定在 `media-engine.lock.json`，不采用本机 PATH 中的其他 FFmpeg，不捆绑 ffplay。模块、缓冲与取消限制见 `media.md`。

初始 BtbN 广泛依赖候选已退出暂存；当前使用固定核心源码与 OpenH264、dav1d、zlib 的精简源构建，两个控制台程序与六个 DLL 约 28 MB。实际五份对应源码、叶子许可证、GCC Runtime Exception、MinGW 通知及离线构建配方已配对并通过媒体供给门。运行时维持版本/完整摘要验证；重建或替换需同步新的验证 pin。社区规模不代替实际格式、Windows 原生体验或供给证据。版本更新继续作为独立提供器处理。

## 验收与更新

新增归档采用固定 libarchive 3.8.11 源构建的可替换 WASM 叶子：窄字节 API、Worker 生命周期、256 MiB 最大内存，无宿主文件系统/进程桥接；不进入任务、聊天或 Agent 协议。上游来源为 [固定官方发行](https://github.com/libarchive/libarchive/releases/tag/v3.8.11)，构建与源码/通知 pin 在 `archive-build/` 和 `archive-engine.lock.json`。没有采用已研究的旧 libarchive.js/libarchive-wasm npm 二进制；维护集中或包装器规模不能代替当前代码与格式证据。实际 15 个 TAR/压缩流/RAR4/5/7z 样本、中文/恶意路径、链接、实际解压预算、WASM 内存上限与截断负例已通过。gzip 尾部 CRC 未作完整性检验，详见 `archives.md`；原生 Worker/字体/MSE 等仍需要单独界面验收。

版本固定不代表已经完成验收。此前 Office/文件容器证据见 `work/desktop-delivery-preview-20261103/ACCEPTANCE.md`；本轮扩展以 `work/desktop-preview-coverage-20261104/README.md` 及其实际日志为准。升级时同步版本锁、官方来源/许可、源码伴随清单、转换/解码样本、原生 CSP 与安装资源验证。用户当前已停止电脑控制，原生画面与交互不能宣称通过。
