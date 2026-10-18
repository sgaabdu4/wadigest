#!/usr/bin/env bash
# macOS: double-click to install (first time) and open wadigest. Linux: run ./"Start wadigest.command"
cd "$(dirname "$0")"
if [ -x "$HOME/.wadigest/bin/wadigest" ]; then
  exec "$HOME/.wadigest/bin/wadigest"
else
  exec bash scripts/install.sh
fi
