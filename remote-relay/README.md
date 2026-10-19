# Trylo relay preview 0.1.1

Desktop owns task execution, workspace selection and approval decisions. This single-process relay routes authenticated HTTP requests and live events to the account's paired Desktop. Desktop must remain online. Both public links use TLS; the relay can see forwarded content. This preview does not implement end-to-end encryption or high availability.

## 部署到这台腾讯云服务器

部署前先确认地域与域名接入条件。中国大陆节点（例如上海）使用自定义域名提供服务前，需要完成 ICP 备案并在腾讯云办理接入；不能把短时 HTTPS 连通当成长期可用。未备案且需要保留现有域名时，应选择中国香港等非中国大陆节点。依据：[腾讯云备案与阻断说明](https://cloud.tencent.com/document/api/243/19630)。

迁移时保留 `.env`、`trylo-relay_relay_data` 和 `trylo-relay_caddy_data`，不要在新节点重新生成账号或设备密钥。先用指定 IP 的 HTTPS 检查确认新节点可用，再修改实际生效 DNS 中 `relay` 的 A 记录；原节点保留到真实手机验证完成。准备备份不等于完成迁移，最终切换前还需要再次制作一致备份。

1. 在域名实际生效的 DNS 服务商处新增 A 记录：主机记录 `relay`，记录值 `111.229.156.46`，TTL 默认。2026-10-18 实测 `trylocode.me` 的权威服务器是 `sullivan.ns.cloudflare.com` 和 `pat.ns.cloudflare.com`，因此应在 Cloudflare DNS 添加，先使用「仅 DNS」（灰云）。阿里云是域名注册商，在未生效的阿里云解析页添加记录不会改变公网解析。保留其他已有记录。若 `relay` 已有记录，先确认它是否仍在使用；不要创建冲突记录。不要新增 AAAA 记录，除非确认服务器 IPv6 路由可用。
2. 在腾讯云该实例的防火墙或安全组中允许入站 TCP 80、443。保留当前 SSH 规则。服务内部端口 8788 不对公网开放。
3. 将 `trylo-relay-0.1.1.tar.gz` 上传到服务器 ubuntu 用户的主目录，在服务器终端运行：

```bash
mkdir -p ~/trylo-relay
tar -xzf ~/trylo-relay-0.1.1.tar.gz -C ~/trylo-relay
cd ~/trylo-relay
bash install.sh relay.trylocode.me
```

首次安装会通过 Ubuntu 软件源安装 Docker，构建服务镜像并启动 Caddy。Docker 镜像需要服务器能访问镜像仓库；下载失败时保留完整错误，不要改用不明镜像站。Caddy 在 DNS 和端口就绪后申请 HTTPS 证书，启动命令完成不代表证书已签发。

若 Docker Hub 无法直连，可先从 AWS ECR 中 Docker 官方镜像库下载并缓存，再运行安装脚本。该方式不需要 AWS 账号，不修改全局 Docker 镜像站配置：

```bash
sudo docker pull public.ecr.aws/docker/library/node:22-bookworm-slim
sudo docker tag public.ecr.aws/docker/library/node:22-bookworm-slim node:22-bookworm-slim
sudo docker pull public.ecr.aws/docker/library/caddy:2-alpine
sudo docker tag public.ecr.aws/docker/library/caddy:2-alpine caddy:2-alpine
```

```bash
curl --fail --show-error https://relay.trylocode.me/health
sudo docker compose ps
```

健康检查应返回 `{"ok":true,"service":"trylo-relay","version":1}`。失败时在安装目录运行 `sudo docker compose logs --tail=60 relay caddy`，只提供错误行；不要发送 `.env` 或账号凭证。

## 配对

服务器安装目录执行下面命令，在自己的终端查看注册邀请码，填入新版 Desktop「设置 → 远程 → 官方服务器」的注册表单。不要把邀请码发到聊天或公开截图。设置一个至少 12 位的独立密码。

```bash
sed -n 's/^RELAY_INVITE_CODE=//p' .env
```

服务器地址 `https://relay.trylocode.me`。注册并登录后启用远程访问并保存设置，从顶栏「远程」生成二维码，使用支持服务器模式的新版手机 App 扫码。二维码有效期两分钟且只能使用一次。手机得到仅限该电脑的凭证，不会拿到账号密码或 Desktop 本地网关密钥。

Desktop 会主动连服务器并在断线后重连，服务器不缓存或重放任务。连接断开或请求超时后，先检查 Desktop 任务状态再决定是否重复发送。手机必须收到初始快照才显示连接成功。

退出 Desktop 服务器账号会撤销该电脑的注册和所有手机凭证。手机重新安装、凭证失效或切换电脑后需要重新扫码。账号登录凭证有效期七天，手机凭证三十天；Desktop 已建立的设备通道可以继续运行，重新配对需要有效账号登录。

## 运维边界

邀请码由安装脚本随机产生，存于权限 600 的 `.env`；账号密码经 scrypt 派生，令牌仅保存哈希。Desktop 会在其应用私有目录保存设备连接凭证，不保存密码。保护应用数据目录和服务器管理员权限。

持久数据在 Docker 卷 `trylo-relay_relay_data`，证书在 `trylo-relay_caddy_data`。停止用 `sudo docker compose down`，升级用 `sudo docker compose up -d --build`；不要添加 `-v`，它会删除持久数据。备份应包含 `.env` 和数据卷，并加密保管；升级前停服制作一致备份。暂不支持多副本或多进程共用数据文件。

服务限制：最多 1000 个账号、每账号 50 台设备、512 个同时 WebSocket、每设备 8 个同时 HTTP 请求、单请求体 512 KiB、单产物约 13 MiB。开放注册前还需要真实手机公网验收、容量和恢复演练；预览邀请码仅给受邀用户。

## 开发与验证

`npm ci && npm test` 会启动独立本机 relay 和真实 Desktop 网关，验证配对、事件、任务、审批和账号隔离。`node scripts/package.mjs` 生成包含 ws 的部署包，不包含账号、邀请码或本机配置。该构建脚本使用仓库已有 esbuild。工程测试与真实服务器 HTTPS、原生 Desktop、APK 设备验收分别记录。
