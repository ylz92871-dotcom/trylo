# 官网源码与 Desktop 更新发布

生产宣传站的维护源码为 marketing/；账号和管理员界面为 console/。历史 app/chat/remote/yl 入口继续保留。构建 marketing/ 后，仅将经过清单校验的公开页面和资源进入静态候选，凭据、源文件、review/ 与本地记录不进入网页服务。

Desktop 更新使用 desktop-release.json 为唯一元数据，包含安装包版本、大小、SHA-256、GitHub 原包地址与更新说明。配置 TRYLO_SSH_HOST、TRYLO_SSH_KNOWN_HOSTS、TRYLO_SSH_KEY、TRYLO_SSH_HOST_FINGERPRINT 后运行 scripts/prepare-desktop-download.mjs、scripts/publish-desktop-download.mjs 和 scripts/verify-desktop-download.mjs。部署前核对当前静态上游、入口和页面哈希，在独立容器验收后才切换上游。脚本保留旧服务、旧版本文件和入口备份，不修改账号/API/relay 数据与路由。

发生并发改动或摘要不一致时停止；回滚前同样应核对当前入口是否仍等于本次 after 摘要，避免覆盖他人更新。GitHub 源码同步、二进制发布、官网部署分别验证。完整宣传片沿用既有的正式媒体资产，不要求公开本机素材库。

## 官网历史版本列表

`desktop-release.json` 的 `history` 仅收录真实发布的 Desktop 安装包/便携包。新增版本时保留历史条目，排除当前最新版和 CoWork。下载页使用原生 details，无脚本亦可展开。`prepare-desktop-download.mjs` 支持同版本页面更新：既有安装包规则必须完全一致；候选部署仍校验入口、包摘要与旧页面，不覆盖版本化安装包。
