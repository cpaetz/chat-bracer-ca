#!/usr/bin/env bash
# install.sh — Deploy bracer-bot to chat-bracer-ca
# Run as root directly on the server
set -euo pipefail

INSTALL_DIR=/opt/bracer-bot
SERVICE=bracer-bot
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Creating bracer-bot user..."
id bracer-bot &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin bracer-bot

echo "==> Setting up $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"

echo "==> Copying bot files..."
cp "$SCRIPT_DIR/bot.py"          "$INSTALL_DIR/"
cp "$SCRIPT_DIR/requirements.txt" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/.env.op"         "$INSTALL_DIR/"
cp "$SCRIPT_DIR/.env.plain"      "$INSTALL_DIR/"
cp "$SCRIPT_DIR/$SERVICE.service" /etc/systemd/system/

echo "==> Copying 1Password token from bracer-register..."
cp /opt/bracer-register/.token-env "$INSTALL_DIR/.token-env"
chmod 600 "$INSTALL_DIR/.token-env"


echo "==> Creating Python venv..."
python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --quiet --upgrade pip
"$INSTALL_DIR/venv/bin/pip" install --quiet -r "$INSTALL_DIR/requirements.txt"

echo "==> Setting permissions..."
chown -R bracer-bot:bracer-bot "$INSTALL_DIR"
chmod 750 "$INSTALL_DIR"
chmod 640 "$INSTALL_DIR/bot.py"
chmod 640 "$INSTALL_DIR/requirements.txt"
chmod 640 "$INSTALL_DIR/.env.plain"
chmod 600 "$INSTALL_DIR/.token-env"
chmod 600 "$INSTALL_DIR/.env.op"

echo "==> Enabling and starting $SERVICE..."
systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"

sleep 2
systemctl status "$SERVICE" --no-pager
echo ""
echo "==> Done. Tail logs with: journalctl -u $SERVICE -f"
