#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
domain="${1:-relay.trylocode.me}"
if [[ ! "$domain" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]] || [[ "$domain" != *.* ]]; then
  echo 'Invalid domain. Use a hostname such as relay.trylocode.me.' >&2; exit 1
fi
[[ -f server.cjs && -f compose.yaml && -f Caddyfile ]] || { echo 'Extract the complete release package first.' >&2; exit 1; }
if ! command -v docker >/dev/null 2>&1 || ! sudo docker compose version >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y docker.io docker-compose-v2
fi
sudo systemctl enable --now docker
if [[ ! -f .env ]]; then
  invite="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  printf 'RELAY_DOMAIN=%s\nRELAY_INVITE_CODE=%s\n' "$domain" "$invite" > .env
else
  grep -Fxq "RELAY_DOMAIN=$domain" .env || { echo 'Existing configuration uses another domain. Check .env before continuing.' >&2; exit 1; }
fi
chmod 600 .env
sudo docker compose --env-file .env config --quiet
sudo docker compose --env-file .env up -d --build
echo "Started. Verify DNS and allow inbound TCP ports 80 and 443 in Tencent Cloud."
echo "Health check: https://$domain/health"
echo 'Keep .env private. To view the registration invite locally: sed -n "s/^RELAY_INVITE_CODE=//p" .env'
echo 'Do not paste the invite into chat. Enter it in Desktop when registering your first account.'
