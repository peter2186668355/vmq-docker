#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

if [[ ${1:-} == --help ]]; then
  printf '用法：bash install.sh\n首次运行时输入支付域名，使用 Docker 启动 V免签、Nginx 和 Certbot。\n'
  exit 0
fi
[[ $# == 0 ]] || fail '用法：bash install.sh'

for cmd in docker curl openssl flock; do
  command -v "$cmd" >/dev/null || fail "请先安装 $cmd，再运行安装脚本。"
done
docker compose version >/dev/null 2>&1 || fail '请先安装 Docker Compose v2 插件。'
docker info >/dev/null 2>&1 || fail '无法连接 Docker，请确认 Docker 已启动且当前用户有权使用。'

exec 9>.env.install.lock
flock -n 9 || fail '已有安装脚本在运行。'

# 只读取脚本自己生成的键。已有手工部署使用原来的 Compose 入口。
unset VMQ_DOMAIN PUBLIC_URL SETUP_TOKEN TRUST_PROXY
config_marker='# Created by VMQ Docker installer'
if [[ -e .env || -L .env ]]; then
  [[ -f .env && ! -L .env ]] && grep -Fxq "$config_marker" .env ||
    fail '当前目录已有手工配置的 .env。请保留现有部署，并在独立目录运行一键安装。'
  domain=$(sed -n 's/^VMQ_DOMAIN=//p' .env)
  setup_token=$(sed -n 's/^SETUP_TOKEN=//p' .env)
  [[ $setup_token =~ ^[a-f0-9]{48}$ ]] || fail '现有 .env 中的初始化令牌格式有误。'
else
  printf '请输入支付域名（例如 pay.example.com）：' >&2
  IFS= read -r domain || fail '请在终端中运行脚本并输入域名。'
  domain=${domain,,}
fi

dns_label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
dns_name="^($dns_label\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$"
[[ ${#domain} -le 253 && $domain =~ $dns_name ]] ||
  fail '请输入完整域名，例如 pay.example.com，域名中不能带协议、端口或路径。'

if [[ ! -f .env ]]; then
  setup_token=$(openssl rand -hex 24)
  tmp_env=$(mktemp .env.install.XXXXXX)
  trap 'rm -f -- "$tmp_env"' EXIT
  printf '%s\nVMQ_DOMAIN=%s\nPUBLIC_URL=https://%s\nSETUP_TOKEN=%s\n' \
    "$config_marker" "$domain" "$domain" "$setup_token" > "$tmp_env"
  mv -- "$tmp_env" .env
  trap - EXIT
fi

compose=(docker compose --env-file .env -f compose.yaml -f compose.nginx.yaml)
"${compose[@]}" config --quiet || fail 'Compose 配置校验失败，请确认使用 Docker Compose v2.24.4 或更新版本。'
printf '正在构建 V免签并启动 Nginx 和 Certbot。\n'
"${compose[@]}" up -d --build --wait --wait-timeout 120

https=(curl -q --silent --show-error --noproxy '*' --resolve "$domain:443:127.0.0.1" --max-time 5)
printf '正在等待证书签发和 HTTPS 健康检查。\n'
deadline=$((SECONDS + 120))
until health=$("${https[@]}" --fail "https://$domain/api/health" 2>/dev/null) && [[ $health == *'"ok":true'* ]]; do
  if (( SECONDS >= deadline )); then
    printf 'HTTPS 尚未就绪。请检查域名解析、80/443 端口和下方容器日志。Certbot 会自动重试。\n' >&2
    "${compose[@]}" logs --tail 25 certbot nginx >&2
    exit 1
  fi
  sleep 3
done

printf 'V免签已启动。站点地址 https://%s\n' "$domain"
setup_status=$(printf 'url = "https://%s/setup?token=%s"\n' "$domain" "$setup_token" |
  "${https[@]}" --config - --output /dev/null --write-out '%{http_code}')
case "$setup_status" in
  200) printf '请在浏览器打开以下初始化链接，创建管理员（请妥善保管链接）\nhttps://%s/setup?token=%s\n' "$domain" "$setup_token" ;;
  404) printf '管理员已初始化。\n' ;;
  *) fail "初始化页面返回 HTTP $setup_status，请查看 vmq 容器日志。" ;;
esac
