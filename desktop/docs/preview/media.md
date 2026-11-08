# 本地媒体兼容预览

媒体先使用平台播放器及原始文件的 Range 读取。浏览器报告编码错误或用户选择“兼容播放”后，通过独立本地 FFmpeg 服务提供 HLS，hls.js 只负责缓冲和定位，播放、音量、拖动、全屏继续使用标准媒体控件。切换时保留位置与播放状态，不启动常驻服务。

## 归属与边界

- 共享元数据与参数策略：`src/preview/media-formats.json`、`src/preview/providers/media-policy.json`、`media-playlist.ts`。
- 前端会话与播放器：`src/host-adapter/preview/media.ts`、`components/preview/media-playback.ts`、`MediaPreview.tsx`。
- 原生服务：`src-tauri/src/preview/media/` 分开负责引擎、策略、进程、会话缓存和连续生产；`commands/preview/media.rs` 只接 IPC。
- 开发适配：`vite-plugins/preview/media-compat/`，同一策略、标准输出和 HLS 时间轴；开发 HTTP 继续验证本地来源和项目范围。
- 原生 `trylo-media` 协议只向 `main` WebView 的所属会话提供清单和分段。HTML/远程浏览器子 WebView 即使知道 token 也被拒绝；该协议不提供任意文件读取或应用 IPC。

引擎只接受已验证文件的可寻址、只读 stdin 文件描述符。固定输入协议 `fd` 及容器白名单，拒绝 HLS/concat/image2/VapourSynth 等能继续加载外部资源或脚本的输入，不能把扩展名当权限。每次生成与读取检查源文件身份/大小/修改时间；转换不回写原文件。它仍不是完整操作系统沙箱。

## 播放与生命周期

一个编码器连续生产 6 秒段，保留 AAC 编码状态；私有 HLS 清单记录标准输出的 byte ranges。读端解析已完成段，前取两个后续段后暂停读取，由有界管道施加反压。空闲约 30 秒停止编码器，缓存保留；关闭预览/应用立即取消所属作业。跳转到未缓存的远位置会先停止旧生产者，再从对应位置重启。

固定视频输出最高 1280×720、30 fps、H.264；音频 AAC 双声道。默认第一条非封面视频轨和第一条音轨，没有内嵌字幕或多音轨切换。原文件仍完整保留，兼容预览不是导出/编辑。短于 0.1 秒的容器尾差合并到最后一个 URI，实际字节不被丢弃；固定 MPEG-TS 起点与 copyts 避免重定位后时间轴漂移。连续前向播放不逐段重启音频编码器。

最多 8 会话、2 进程、8 个待返回的原生片段请求；缓存按每会话 16 MB 限制，合计 128 MB，此外还有有界的当前输出/响应缓冲。单段 16 MB、探测输出 256 KB、清单 16 MB，探测 15 秒、请求 30 秒；时长最多 7 天。暂停反压与空闲停止不按整部影片的总时长超时。超界、源文件改变或编码失败有明确错误与重新加载入口。

## 引擎供给

`scripts/preview/media-engine.lock.json` 固定自建 FFmpeg 9.0.2 / commit 1e65c6cd5d3d2d12cbb374460dbf08bedf54772a 的 LGPL-2.1+ 共享变体：两个控制台程序、六个 FFmpeg DLL，共约 28 MB。关闭 GPL/nonfree/version3、网络、设备、GPU 后端，只链接 OpenH264 2.7.0、dav1d 1.5.4、zlib 三个叶子库。PE 导入核对不依赖编译器 DLL 或 PATH；Windows UCRT 由系统提供。原始广泛 BtbN 候选只作为历史试验保留，不再随产品暂存。

`media-sources.lock.json` 与真实 FFmpeg/OpenH264/dav1d/zlib/hls.js 五份源码归档配对；原始许可、GCC Runtime Exception、MinGW 通知已随引擎保留。`media-build/` 提供有固定工具摘要的离线构建配方和安全解包，不全局安装、不运行播放器。原样源码、完整构建配方和通知进入源码伴随包；发行门检查每项摘要和配方身份，不能单改 complete 标志绕过。当前媒体供给门已通过，新安装候选仍需整轮归档供给与构建冻结后再生成。

`stage-media-engine.mjs --from <已校验的构建目录>` 只暂存固定文件；`--check` 拒绝额外资源。运行时不搜索系统 PATH、不采用系统 FFmpeg、不下载引擎。开发可显式设置 `TRYLO_MEDIA_ENGINE_ROOT`。重建说明见 `scripts/preview/media-build/README.md`。

## 已有证据

本轮 `work/desktop-preview-coverage-20261104/` 保存独立后台原生/开发服务证据：24 份真实视频/音频容器与编码样本可经生产服务转为 H.264/AAC，70 秒样本远距离与向后定位、14 秒尾段、音频时间戳、关闭取消、原件 SHA256 和临时文件清理分别核对。负例强制指定 HLS/concat/image2/VapourSynth，且单独放行 HLS 以验证 `file`/HTTP 引用仍被 `fd` 协议白名单拒绝。

这些证据不等于 WebView2/MSE 实际播放、原生画面、声画同步、人手拖动体验、安装/重启已经通过。用户仍明确停止电脑控制，没有为这些项目启动任何应用/播放器窗口。
