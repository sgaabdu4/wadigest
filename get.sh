#!/usr/bin/env bash
# One-command install for macOS and Linux:
#   curl -fsSL https://raw.githubusercontent.com/sgaabdu4/wadigest/main/get.sh | bash
# Downloads wadigest into ~/.wadigest/app (replacing any older copy), then runs its installer.
# Extra installer options go after `bash -s --`, e.g. `| bash -s -- --terminal`.
set -euo pipefail

REPO="${WADIGEST_REPO:-sgaabdu4/wadigest}"
REF="${WADIGEST_REF:-main}"
WD_HOME="${WADIGEST_HOME:-$HOME/.wadigest}"
APP="$WD_HOME/app"

printf '\033[1m==>\033[0m Downloading wadigest\n'
mkdir -p "$WD_HOME"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" -o "$tmp/app.tar.gz"
mkdir "$tmp/app"
tar -xzf "$tmp/app.tar.gz" -C "$tmp/app" --strip-components 1
[ -f "$tmp/app/scripts/install.sh" ] || { echo "The download looks wrong (no scripts/install.sh)." >&2; exit 1; }
rm -rf "$APP.old"
[ -d "$APP" ] && mv "$APP" "$APP.old"
mv "$tmp/app" "$APP"
rm -rf "$APP.old"

# Piped into bash, stdin is this script; give the installer the keyboard back.
if [ ! -t 0 ] && [ -r /dev/tty ] && (: < /dev/tty) 2>/dev/null; then
  exec bash "$APP/scripts/install.sh" "$@" < /dev/tty
fi
exec bash "$APP/scripts/install.sh" "$@"
