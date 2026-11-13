#!/bin/sh
set -eu

# 首次签发失败时保留 HTTP 验证入口，每 20 分钟重试。
until certbot certonly --non-interactive --agree-tos --keep-until-expiring \
  --webroot --webroot-path /var/www/acme --cert-name "$VMQ_DOMAIN" -d "$VMQ_DOMAIN"; do
  sleep 1200
done

while sleep 43200; do
  certbot renew --non-interactive --cert-name "$VMQ_DOMAIN" || true
done
