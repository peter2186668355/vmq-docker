#!/bin/sh
set -eu

cert_dir="/etc/letsencrypt/live/$VMQ_DOMAIN"
tls_config=/etc/nginx/conf.d/vmq-https.conf

certificate_version() {
  [ -s "$cert_dir/fullchain.pem" ] && [ -s "$cert_dir/privkey.pem" ] || return 1
  # Certbot 更新证书后会切换指向 archive 的符号链接。
  readlink "$cert_dir/fullchain.pem"
  readlink "$cert_dir/privkey.pem"
}

rm -f /etc/nginx/conf.d/default.conf "$tls_config"
envsubst '${VMQ_DOMAIN}' < /opt/vmq/nginx/http.conf.template > /etc/nginx/conf.d/vmq-http.conf
loaded_version=''

load_certificate() {
  if [ ! -f "$tls_config" ]; then
    envsubst '${VMQ_DOMAIN}' < /opt/vmq/nginx/https.conf.template > "$tls_config"
    if ! nginx -t; then
      rm -f "$tls_config"
      return 1
    fi
  else
    nginx -t || return 1
  fi
}

if version=$(certificate_version) && load_certificate; then
  loaded_version=$version
fi

# 独立检查证书文件，Certbot 无需访问 Docker socket 或 Nginx 进程。
(
  while sleep 10; do
    if version=$(certificate_version) && [ "$version" != "$loaded_version" ] &&
      load_certificate && nginx -s reload; then
      loaded_version=$version
    fi
  done
) &

exec nginx -g 'daemon off;'
