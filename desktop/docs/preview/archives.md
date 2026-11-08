# 本地归档阅读

Code、Work 与文件列表共用 `ArchivePreview`，目录和选中内容是同一个阅读入口。`formats.ts` 管分类，`providers/archive.ts` 管来源与预算，`archive-types.ts` 是字节提供器契约；ZIP 和 libarchive 的实现不进入 `App.tsx`。

ZIP/JAR/WAR/WHL/NUPKG/VSIX 继续用已有 JSZip，先做中央目录预算预检，选中时才加载流式解压器。其余 RAR4/5、7z、TAR、gzip/bzip2/xz/LZMA/zstd 与 CPIO/ar 使用独立的 libarchive 3.8.11 Worker。只浏览目录和读取选定内容，不提取到项目，不把归档路径交给宿主，不跟随链接。重复路径按条目 index 定位；ZIP 中无法可靠定位的重名条目拒绝读取。

选中内容复用代码、全文、Markdown、图片、PDF、CSV 和 Notebook 的现有组件。目录可筛选、分页；未知大小明确显示未知。没有相应渲染器的二进制条目会解释限制，保留原归档的外部打开入口。加密、分卷、特殊压缩方法、损坏文件，以及超预算的复杂 solid 归档仍可能需要外部应用。

默认预算：原归档 100 MiB、10,000 条目、4 MiB 路径文本；单条目 **实际解压输出** 10 MiB。ZIP 条目 5 秒，其他归档的独立 Worker 8 秒，包含初始化与读取；关闭或切换立即终止所属 Worker。libarchive 源构建关闭文件系统，32 MiB 初始、256 MiB 最大线性内存。目录元数据和条目头声明大小不能绕过实际输出或 WASM 内存上限。

这是内容阅读器，不是归档完整性校验工具。libarchive 3.8.11 的 gzip 过滤器未验证尾部 CRC/长度，单改该校验字段而内容仍能解码时会继续显示；ZIP 当前读取也不执行全归档 CRC 检查。截断、无法解码和超预算会报错，但“能预览”不能证明整个归档无损。需要完整性检验或修复时使用专用归档工具。

libarchive 并非使用旧 npm 包内的 3.7.7 二进制。本轮从固定官方 3.8.11 源码及固定 zlib、bzip2、liblzma、Zstandard 源构建，保留原始源码与通知。C shim 提供只读条目大小、普通文件判断，以及 bzip2 无 stdio 模式要求的内部错误终止回调；后者只终止所属 WASM 作业。构建与替换说明见 `scripts/preview/archive-build/README.md`。运行资源位于安装目录 `preview/codecs/archive/`，开发/浏览器由同一文件映射提供；真实 source/vendor/recipe 摘要由 `archive-engine.lock.json` 和发行门配对。

当前验收状态以 `work/desktop-preview-coverage-20261104/README.md` 和实际日志为准；源码存在、类型检查和格式路由不等于真实解码通过。Windows 原生界面与安装验收受用户的“停止电脑控制”约束，不能用 Node Worker 矩阵代替。
