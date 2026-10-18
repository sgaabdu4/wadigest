#!/usr/bin/env bash
# Builds wacli v0.22.0 with wadigest's `messages pin` command added.
#   bash wacli-fork/build.sh [output-path]      (default: ~/.wadigest/bin/wacli)
# Needs Go 1.27+ and a C compiler (Xcode Command Line Tools on macOS, build-essential on Linux).
# The installer runs this for you when it can.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-${WADIGEST_HOME:-$HOME/.wadigest}/bin/wacli}"
TAG="${WACLI_TAG:-v0.22.0}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v go >/dev/null || { echo "Go is not installed (brew install go)"; exit 1; }
command -v git >/dev/null || { echo "git is not installed"; exit 1; }

echo "==> Fetching wacli $TAG"
git -c advice.detachedHead=false clone -q --depth 1 --branch "$TAG" https://github.com/openclaw/wacli "$WORK/wacli"
cd "$WORK/wacli"

echo "==> Adding 'messages pin'"
cp "$HERE/messages_pin.go" cmd/wacli/messages_pin.go
# Register the command next to the other messages subcommands.
if ! grep -q newMessagesPinCmd cmd/wacli/messages.go; then
  perl -0pi -e 's/(\tcmd\.AddCommand\(newMessagesForwardCmd\(flags\)\)\n)/$1\tcmd.AddCommand(newMessagesPinCmd(flags))\n/' cmd/wacli/messages.go
fi
grep -q newMessagesPinCmd cmd/wacli/messages.go || { echo "Couldn't register the pin command (wacli layout changed?)"; exit 1; }

echo "==> Building (a few minutes the first time)"
export CGO_ENABLED=1 GOTOOLCHAIN=auto
[ "$(uname -s)" = Linux ] && export CGO_CFLAGS="${CGO_CFLAGS:--Wno-error=missing-braces}"
VERSION="${TAG#v}-wadigest"
go build -trimpath -tags sqlite_fts5 -ldflags "-s -w -X main.version=$VERSION" -o "$WORK/wacli-bin" ./cmd/wacli

mkdir -p "$(dirname "$OUT")"
[ -L "$OUT" ] && rm -f "$OUT"
install -m 0755 "$WORK/wacli-bin" "$OUT"
"$OUT" messages pin --help | grep -qi unpin && echo "✓ Built $OUT with message pinning"
