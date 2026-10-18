#!/usr/bin/env bash
# Removes the background service and ~/.wadigest (config, members, logs, the linked WhatsApp session).
# Afterwards also remove the device on your phone: WhatsApp → Settings → Linked devices.
set -euo pipefail
WD_HOME="${WADIGEST_HOME:-$HOME/.wadigest}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node "$APP_DIR/bin/wadigest.js" service uninstall 2>/dev/null || true
read -r -p "Delete $WD_HOME (config, members, linked WhatsApp session)? [y/N] " a
if [[ "$a" =~ ^[Yy] ]]; then rm -rf "$WD_HOME"; echo "Deleted."; else echo "Kept $WD_HOME."; fi
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
  [ -f "$rc" ] && sed -i.bak '/# wadigest/,+1d' "$rc" && rm -f "$rc.bak"
done
echo "Done. Remove the linked device in WhatsApp → Settings → Linked devices."
