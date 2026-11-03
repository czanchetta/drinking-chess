#!/usr/bin/env bash
# Instala o Beer Chess como serviço (systemd) num Raspberry Pi ou em qualquer Linux.
# Não mexe no Pi-hole nem em pacotes do sistema: o Node.js vai para ~/.local.
#
# Uso (dentro da pasta do projeto):  bash scripts/instalar-raspberry.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE=beer-chess
NODE_MAJOR=22
NODE_DIR="$HOME/.local/node-v${NODE_MAJOR}"
ENV_FILE="$APP_DIR/.env"

say() { printf '\n\033[1;33m🍺 %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Rode como seu usuário normal (sem sudo). O script pede a senha do sudo só quando precisa."
command -v systemctl >/dev/null || die "Este script precisa de systemd (Raspberry Pi OS tem)."
command -v curl >/dev/null || die "Falta o curl: sudo apt install -y curl"

# 1. Node.js 20+ (usa o do sistema se já for novo o bastante)
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
NODE_BIN=""
if command -v node >/dev/null && [ "$(node_major node)" -ge 20 ]; then
  NODE_BIN="$(command -v node)"
elif [ -x "$NODE_DIR/bin/node" ] && [ "$(node_major "$NODE_DIR/bin/node")" -ge 20 ]; then
  NODE_BIN="$NODE_DIR/bin/node"
else
  case "$(uname -m)" in
    aarch64 | arm64) ARCH=arm64 ;;
    armv7l) ARCH=armv7l ;;
    x86_64) ARCH=x64 ;;
    armv6l) die "Este Raspberry é ARMv6 (Pi Zero/Zero W ou Pi 1): o Node.js oficial não roda nele. Precisa de um Pi 2 ou mais novo (o Zero 2 W serve)." ;;
    *) die "Arquitetura $(uname -m) não suportada por este script." ;;
  esac
  say "Baixando o Node.js ${NODE_MAJOR} para ${ARCH}…"
  BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  FILE="$(grep -oE "node-v[0-9.]+-linux-${ARCH}\.tar\.gz" "$TMP/SHASUMS256.txt" | head -n1)"
  [ -n "$FILE" ] || die "Não achei o Node.js ${NODE_MAJOR} para ${ARCH} em ${BASE}."
  curl -fSL --progress-bar "$BASE/$FILE" -o "$TMP/$FILE"
  (cd "$TMP" && grep " ${FILE}\$" SHASUMS256.txt | sha256sum -c - >/dev/null) || die "O download do Node.js veio corrompido. Rode de novo."
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xzf "$TMP/$FILE" -C "$NODE_DIR" --strip-components=1
  NODE_BIN="$NODE_DIR/bin/node"
fi
NODE_PATH_DIR="$(dirname "$NODE_BIN")"
export PATH="$NODE_PATH_DIR:$PATH"
say "Usando Node $(node -v) ($NODE_BIN)"

# 2. Dependências do bot
say "Instalando as dependências do bot…"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund

# 3. Token do Discord (fica só neste arquivo, legível só pelo seu usuário)
if [ -f "$ENV_FILE" ] && grep -qE '^DISCORD_TOKEN=.+' "$ENV_FILE"; then
  say "Usando o token que já está em .env"
else
  say "Cole o token do bot (Discord Developer Portal > Bot > Redefinir token) e aperte Enter."
  printf '   O token não aparece na tela enquanto você cola. Token: '
  read -rs TOKEN </dev/tty
  echo
  TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
  [ -n "$TOKEN" ] || die "Token vazio. Rode o script de novo."
  (umask 077 && printf 'DISCORD_TOKEN=%s\n' "$TOKEN" >"$ENV_FILE")
fi
chmod 600 "$ENV_FILE"

# 4. Serviço que liga sozinho com o Raspberry e reinicia se cair
say "Criando o serviço ${SERVICE} (vai pedir a senha do sudo)…"
sudo tee "/etc/systemd/system/${SERVICE}.service" >/dev/null <<EOF
[Unit]
Description=Beer Chess (bot de Discord)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN src/index.js
Restart=always
RestartSec=10
# prioridade e memória limitadas para não atrapalhar o Pi-hole
Nice=10
MemoryMax=300M

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE" >/dev/null
sudo systemctl restart "$SERVICE"

sleep 8
if systemctl is-active --quiet "$SERVICE"; then
  say "Pronto! O bot está rodando e liga sozinho quando o Raspberry reiniciar."
else
  say "O serviço não ficou de pé. O log abaixo diz o porquê:"
fi
journalctl -u "$SERVICE" -n 15 --no-pager 2>/dev/null || sudo journalctl -u "$SERVICE" -n 15 --no-pager
cat <<EOF

Comandos úteis:
  ver o log ao vivo:   journalctl -u ${SERVICE} -f
  reiniciar:           sudo systemctl restart ${SERVICE}
  atualizar o bot:     bash ${APP_DIR}/scripts/atualizar.sh
  trocar o token:      apague ${ENV_FILE} e rode este script de novo
EOF
