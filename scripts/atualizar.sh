#!/usr/bin/env bash
# Puxa a versão mais nova do GitHub e reinicia o serviço.
# Uso:  bash scripts/atualizar.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE=beer-chess
NODE_DIR="$HOME/.local/node-v22"

[ -x "$NODE_DIR/bin/node" ] && export PATH="$NODE_DIR/bin:$PATH"
command -v node >/dev/null || { echo "Node.js não encontrado. Rode scripts/instalar-raspberry.sh primeiro." >&2; exit 1; }

cd "$APP_DIR"
echo "🍺 Baixando a versão nova…"
git pull --ff-only
npm ci --omit=dev --no-audit --no-fund
sudo systemctl restart "$SERVICE"
sleep 8
journalctl -u "$SERVICE" -n 10 --no-pager 2>/dev/null || sudo journalctl -u "$SERVICE" -n 10 --no-pager
