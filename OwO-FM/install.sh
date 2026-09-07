#!/usr/bin/env bash
# OwO.FM installer — Ubuntu 24.04
# Domain: owofm.space
# Stream path: MPD httpd (8001/8002) via Caddy — see install_stack.md
set -euo pipefail

DOMAIN="owofm.space"
CONFIG_DIR="/etc/owo"
ENV_FILE="${CONFIG_DIR}/owo.env"
WWW_DIR="/var/www/owo"
MUSIC_DIR="/var/lib/mpd/music"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== OwO.FM Installer (Ubuntu 24.04) / ${DOMAIN} ==="

if [[ "${EUID}" -ne 0 ]]; then
  echo "Нужен root: sudo bash install.sh"
  exit 1
fi

# --- flags ---
NAIVE_CHOICE="${INSTALL_NAIVE:-}"
if [[ -z "${NAIVE_CHOICE}" ]]; then
  read -r -p "Ставить Caddy с NaiveProxy (сборка xcaddy, нужен RAM/swap)? [y/N]: " NAIVE_CHOICE
fi

if [[ -z "${BOT_TOKEN:-}" ]]; then
  read -r -p "Telegram BOT_TOKEN (пусто = бота не включать): " BOT_TOKEN || true
fi
if [[ -z "${ADMIN_IDS:-}" ]]; then
  read -r -p "Telegram ADMIN_IDS через запятую: " ADMIN_IDS || true
fi

ADMIN_TOKEN="$(openssl rand -hex 24)"
mkdir -p "${CONFIG_DIR}" "${WWW_DIR}" \
  "${MUSIC_DIR}/owo/party" "${MUSIC_DIR}/owo/chill" "${MUSIC_DIR}/citypop" \
  /var/lib/mpd/owo/playlists /var/lib/mpd/citypop/playlists \
  /var/log/mpd /var/lib/owo /etc/mpd

# --- env (ADMIN_TOKEN только сервер: API + bot; НЕ в публичный JS) ---
cat > "${ENV_FILE}" <<EOF
SITE_URL=https://${DOMAIN}
ADMIN_TOKEN=${ADMIN_TOKEN}
API_PORT=8787
SKIP_AUTH=token
BOT_TOKEN=${BOT_TOKEN:-}
ADMIN_IDS=${ADMIN_IDS:-}
MPD_OWO_HOST=127.0.0.1
MPD_OWO_PORT=6600
MPD_CITY_HOST=127.0.0.1
MPD_CITY_PORT=6601
MUSIC_ROOT=${MUSIC_DIR}
WWW_ROOT=${WWW_DIR}
MODE_FILE=/var/lib/owo/mode
STREAM_OWO=https://${DOMAIN}/stream/owo
STREAM_CITY=https://${DOMAIN}/stream/citypop
EOF
chmod 600 "${ENV_FILE}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y mpd mpc ffmpeg python3-venv python3-pip curl git openssl \
  debian-keyring debian-archive-keyring apt-transport-https gnupg

# lame for mpd httpd encoder
apt-get install -y libmpdclient2 || true
apt-get install -y lame libmp3lame0 || true

systemctl disable --now mpd 2>/dev/null || true

# --- MPD confs from repo ---
if [[ -f "${REPO_ROOT}/mpd/mpd-owo.conf" ]]; then
  cp "${REPO_ROOT}/mpd/mpd-owo.conf" /etc/mpd/mpd-owo.conf
  cp "${REPO_ROOT}/mpd/mpd-citypop.conf" /etc/mpd/mpd-citypop.conf
else
  echo "WARN: нет mpd/*.conf в репо — создаю минимальные"
  cat > /etc/mpd/mpd-owo.conf <<'MPDEOF'
music_directory     "/var/lib/mpd/music"
playlist_directory  "/var/lib/mpd/owo/playlists"
db_file             "/var/lib/mpd/owo/tag_cache"
state_file          "/var/lib/mpd/owo/state"
sticker_file        "/var/lib/mpd/owo/sticker.sql"
log_file            "/var/log/mpd/mpd-owo.log"
pid_file            "/run/mpd/mpd-owo.pid"
bind_to_address     "127.0.0.1"
port                "6600"
user                "mpd"
audio_output {
    type            "httpd"
    name            "OwO Stream"
    encoder         "lame"
    port            "8001"
    bind_to_address "127.0.0.1"
    bitrate         "128"
    format          "44100:16:2"
    max_clients     "16"
}
audio_output {
    type "null"
    name "Null"
}
MPDEOF
  sed 's/6600/6601/g;s/8001/8002/g;s|/owo/|/citypop/|g;s/OwO/CityPop/g;s/mpd-owo/mpd-citypop/g' \
    /etc/mpd/mpd-owo.conf > /etc/mpd/mpd-citypop.conf
fi

chown -R mpd:mpd /var/lib/mpd /var/log/mpd
# бот должен писать в music
usermod -aG mpd root 2>/dev/null || true
chmod -R 775 "${MUSIC_DIR}"

# systemd mpd units
cat > /etc/systemd/system/mpd-owo.service <<'EOF'
[Unit]
Description=MPD OwO
After=network.target
[Service]
Type=simple
ExecStart=/usr/bin/mpd --no-daemon /etc/mpd/mpd-owo.conf
User=mpd
Group=mpd
Restart=on-failure
RuntimeDirectory=mpd
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/mpd-citypop.service <<'EOF'
[Unit]
Description=MPD CityPop
After=network.target
[Service]
Type=simple
ExecStart=/usr/bin/mpd --no-daemon /etc/mpd/mpd-citypop.conf
User=mpd
Group=mpd
Restart=on-failure
RuntimeDirectory=mpd
[Install]
WantedBy=multi-user.target
EOF

# --- Caddy ---
install_caddy_stock() {
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
}

install_caddy_naive() {
  echo "=== Сборка Caddy + Naive forwardproxy (swap при RAM < 2G) ==="
  local mem
  mem="$(free -m | awk '/^Mem:/{print $2}')"
  if [[ "${mem}" -lt 2000 ]]; then
    fallocate -l 2G /swapfile_builder 2>/dev/null \
      || dd if=/dev/zero of=/swapfile_builder bs=1M count=2048 status=none
    chmod 600 /swapfile_builder
    mkswap /swapfile_builder
    swapon /swapfile_builder
  fi

  local GOVER="1.22.10"
  if ! command -v go >/dev/null 2>&1 || [[ "$(go env GOVERSION 2>/dev/null || true)" != go1.22* && "$(go env GOVERSION 2>/dev/null || true)" != go1.23* ]]; then
    curl -fsSL "https://go.dev/dl/go${GOVER}.linux-amd64.tar.gz" -o /tmp/go.tgz
    rm -rf /usr/local/go && tar -C /usr/local -xzf /tmp/go.tgz
    export PATH="/usr/local/go/bin:${PATH}"
  fi
  export PATH="/usr/local/go/bin:${PATH}"
  export GOPATH=/tmp/gopath
  export HOME=/tmp
  go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
  /tmp/gopath/bin/xcaddy build \
    --with github.com/caddyserver/forwardproxy=github.com/klzgrad/forwardproxy@naive
  mv -f caddy /usr/bin/caddy
  chmod +x /usr/bin/caddy

  if [[ -f /swapfile_builder ]]; then
    swapoff /swapfile_builder || true
    rm -f /swapfile_builder
  fi

  if [[ ! -f /lib/systemd/system/caddy.service ]]; then
    cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy
After=network.target
[Service]
ExecStart=/usr/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
User=caddy
Group=caddy
AmbientCapabilities=CAP_NET_BIND_SERVICE
TimeoutStopSec=5s
LimitNOFILE=1048576
[Install]
WantedBy=multi-user.target
EOF
    useradd -r -d /var/lib/caddy -s /usr/sbin/nologin caddy 2>/dev/null || true
    mkdir -p /etc/caddy /var/lib/caddy
    chown -R caddy:caddy /var/lib/caddy
  fi
}

if [[ "${NAIVE_CHOICE}" =~ ^[Yy]$|^[Tt][Rr][Uu][Ee]$ ]]; then
  install_caddy_naive
  mkdir -p "${CONFIG_DIR}"
  if [[ ! -f "${CONFIG_DIR}/naive-users.txt" ]]; then
    echo "user1:$(openssl rand -hex 8)" > "${CONFIG_DIR}/naive-users.txt"
    chmod 600 "${CONFIG_DIR}/naive-users.txt"
    echo "Naive users sample → ${CONFIG_DIR}/naive-users.txt (замените!)"
  fi
else
  install_caddy_stock
fi

mkdir -p /etc/caddy
if [[ -f "${REPO_ROOT}/caddy/Caddyfile" ]]; then
  cp "${REPO_ROOT}/caddy/Caddyfile" /etc/caddy/Caddyfile
else
  echo "WARN: положите caddy/Caddyfile вручную (см. install_stack.md)"
fi

# --- web ---
if [[ -d "${REPO_ROOT}/web" ]]; then
  rsync -a --delete "${REPO_ROOT}/web/" "${WWW_DIR}/" 2>/dev/null \
    || cp -a "${REPO_ROOT}/web/." "${WWW_DIR}/"
fi
mkdir -p "${WWW_DIR}/img/covers" "${WWW_DIR}/icons"
chown -R www-data:www-data "${WWW_DIR}" 2>/dev/null || chown -R caddy:caddy "${WWW_DIR}"

# --- API venv ---
if [[ -d "${REPO_ROOT}/api" ]]; then
  python3 -m venv /opt/owo-api
  /opt/owo-api/bin/pip install -U pip
  if [[ -f "${REPO_ROOT}/api/requirements.txt" ]]; then
    /opt/owo-api/bin/pip install -r "${REPO_ROOT}/api/requirements.txt"
  else
    /opt/owo-api/bin/pip install fastapi uvicorn
  fi
  rsync -a "${REPO_ROOT}/api/" /opt/owo-api/app/
  cat > /etc/systemd/system/owo-api.service <<EOF
[Unit]
Description=OwO.FM API
After=network.target mpd-owo.service mpd-citypop.service
[Service]
EnvironmentFile=${ENV_FILE}
WorkingDirectory=/opt/owo-api/app
ExecStart=/opt/owo-api/bin/uvicorn main:app --host 127.0.0.1 --port 8787
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF
fi

# --- Bot ---
if [[ -n "${BOT_TOKEN:-}" && -d "${REPO_ROOT}/bot" ]]; then
  python3 -m venv /opt/owo-bot
  /opt/owo-bot/bin/pip install -U pip
  if [[ -f "${REPO_ROOT}/bot/requirements.txt" ]]; then
    /opt/owo-bot/bin/pip install -r "${REPO_ROOT}/bot/requirements.txt"
  else
    /opt/owo-bot/bin/pip install aiogram aiohttp
  fi
  rsync -a "${REPO_ROOT}/bot/" /opt/owo-bot/app/
  cat > /etc/systemd/system/owo-bot.service <<EOF
[Unit]
Description=OwO.FM Telegram Bot
After=network.target mpd-owo.service owo-api.service
[Service]
EnvironmentFile=${ENV_FILE}
WorkingDirectory=/opt/owo-bot/app
ExecStart=/opt/owo-bot/bin/python main.py
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF
fi

systemctl daemon-reload
systemctl enable --now mpd-owo mpd-citypop
systemctl enable --now caddy || systemctl restart caddy
systemctl enable --now owo-api 2>/dev/null || true
systemctl enable --now owo-bot 2>/dev/null || true

# initial playlist OwO = all
sleep 1
mpc -p 6600 update || true
mpc -p 6601 update || true
mpc -p 6600 clear || true
mpc -p 6600 add owo/party || true
mpc -p 6600 add owo/chill || true
mpc -p 6600 random on || true
mpc -p 6600 play || true
mpc -p 6601 clear || true
mpc -p 6601 add citypop || true
mpc -p 6601 random on || true
mpc -p 6601 play || true
echo "all" > /var/lib/owo/mode

echo ""
echo "=== Готово ==="
echo "ADMIN_TOKEN (только сервер/бот/remote, НЕ в публичный JS):"
echo "  ${ADMIN_TOKEN}"
echo "Env: ${ENV_FILE}"
echo "Streams: https://${DOMAIN}/stream/owo | /stream/citypop"
echo "Положите ассеты: ${WWW_DIR}/img/mascot.webp, default-cover.webp, icons/"
echo "DNS A-запись ${DOMAIN} → этот сервер обязательна для HTTPS."
