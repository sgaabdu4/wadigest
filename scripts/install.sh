#!/usr/bin/env bash
# wadigest installer for macOS and Linux.
#   bash scripts/install.sh               install, then run the guided setup (link WhatsApp, pick group)
#   bash scripts/install.sh --with-video  also install ffmpeg + whisper.cpp to transcribe videos
#   bash scripts/install.sh --no-setup    install only
#   bash scripts/install.sh --no-pin      skip building the pin-capable wacli
#   bash scripts/install.sh --group "Developer Bros"   skip the "which group?" question
#   bash scripts/install.sh --terminal    do everything in the terminal, no setup page
# On a computer with a screen, the setup page opens straight after Node.js is ready and
# finishes the install itself (it runs this script again with --from-ui).
# Safe to run again (upgrades in place). Everything goes in ~/.wadigest.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WD_HOME="${WADIGEST_HOME:-$HOME/.wadigest}"
BIN_DIR="$WD_HOME/bin"
WITH_VIDEO=0
WITH_PIN=1
RUN_SETUP=1
FROM_UI=0
TERMINAL=0
SETUP_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --with-video) WITH_VIDEO=1 ;;
    --no-setup) RUN_SETUP=0 ;;
    --from-ui) RUN_SETUP=0; FROM_UI=1 ;;
    --terminal) TERMINAL=1; SETUP_ARGS+=(--terminal) ;;
    --no-pin) WITH_PIN=0 ;;
    --group) shift; SETUP_ARGS+=(--group "${1:-}") ;;
    --group=*) SETUP_ARGS+=(--group "${1#--group=}") ;;
    --phone) shift; SETUP_ARGS+=(--phone "${1:-}") ;;
    -h|--help) sed -n 2,8p "$0"; exit 0 ;;
    *) echo "Unknown option $1"; exit 2 ;;
  esac
  shift
done

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS" in
  Darwin) PLATFORM=darwin ;;
  Linux)  PLATFORM=linux ;;
  *) die "Unsupported OS $OS. On Windows, use WSL (Ubuntu) and run this script there." ;;
esac
case "$ARCH" in
  arm64|aarch64) GOARCH=arm64 ;;
  x86_64|amd64)  GOARCH=amd64 ;;
  *) die "Unsupported CPU $ARCH" ;;
esac
HAVE_BREW=0; command -v brew >/dev/null 2>&1 && HAVE_BREW=1
mkdir -p "$BIN_DIR" "$WD_HOME/logs"
chmod 700 "$WD_HOME"

say "wadigest installer ($PLATFORM/$GOARCH)"

# ---------- 1. Node.js 20+ ----------
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }
RUNTIME="$WD_HOME/runtime"
[ -x "$RUNTIME/node/bin/node" ] && export PATH="$RUNTIME/node/bin:$PATH"
install_private_node() {
  say "Downloading Node.js (private copy for wadigest)"
  local base="https://nodejs.org/dist/latest-v22.x" tmp name sums
  case "$PLATFORM-$GOARCH" in
    darwin-arm64) suffix=darwin-arm64 ;; darwin-amd64) suffix=darwin-x64 ;;
    linux-arm64) suffix=linux-arm64 ;; linux-amd64) suffix=linux-x64 ;;
  esac
  tmp="$(mktemp -d)"
  sums="$(curl -fsSL "$base/SHASUMS256.txt")" || die "Couldn't reach nodejs.org"
  name="$(printf '%s\n' "$sums" | awk '{print $2}' | grep -E "^node-v[0-9.]+-${suffix}\.tar\.gz$" | head -1)"
  [ -n "$name" ] || die "No Node.js build for $suffix"
  curl -fL --progress-bar -o "$tmp/$name" "$base/$name"
  local want got
  want="$(printf '%s\n' "$sums" | awk -v n="$name" '$2==n {print $1}')"
  if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/$name" | awk '{print $1}')"; else got="$(shasum -a 256 "$tmp/$name" | awk '{print $1}')"; fi
  [ "$want" = "$got" ] || die "Node.js download failed its checksum check"
  rm -rf "$RUNTIME/node" && mkdir -p "$RUNTIME"
  tar -xzf "$tmp/$name" -C "$RUNTIME" && mv "$RUNTIME/${name%.tar.gz}" "$RUNTIME/node"
  rm -rf "$tmp"
  export PATH="$RUNTIME/node/bin:$PATH"
}
if node_ok; then
  ok "Node $(node -v)"
else
  install_private_node
  node_ok || die "Node install failed"
  ok "Node $(node -v) (private copy in $RUNTIME)"
fi
NODE_BIN="$(command -v node)"

# ---------- 1b. the wadigest command ----------
cat > "$BIN_DIR/wadigest" <<EOF
#!/usr/bin/env bash
export WADIGEST_HOME="$WD_HOME"
exec "$NODE_BIN" "$APP_DIR/bin/wadigest.js" "\$@"
EOF
chmod +x "$BIN_DIR/wadigest"
ok "wadigest command → $BIN_DIR/wadigest (runs $APP_DIR)"

add_path() {
  local rc="$1"
  [ -f "$rc" ] || touch "$rc"
  grep -q '.wadigest/bin' "$rc" 2>/dev/null || printf '\n# wadigest\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$rc"
}
case "${SHELL:-}" in
  */zsh) add_path "$HOME/.zshrc" ;;
  */bash) add_path "$HOME/.bashrc"; [ "$PLATFORM" = darwin ] && add_path "$HOME/.bash_profile" ;;
  *) add_path "$HOME/.profile" ;;
esac
export PATH="$BIN_DIR:$PATH"

has_screen() {
  [ "${WADIGEST_UI:-}" = 1 ] && return 0
  [ "${WADIGEST_UI:-}" = 0 ] && return 1
  [ -n "${SSH_CONNECTION:-}${SSH_TTY:-}" ] && return 1
  [ "$PLATFORM" = darwin ] || [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]
}
if [ "$RUN_SETUP" = 1 ] && [ "$TERMINAL" = 0 ] && [ "$WITH_VIDEO" = 0 ] && has_screen; then
  echo
  say "Opening setup in your browser. Keep this window open until the page says you're all set."
  rm -f "$WD_HOME/installed"
  exec "$BIN_DIR/wadigest" setup --ui
fi

# ---------- 2. wacli ----------
PIN_REPO="${WADIGEST_REPO:-sgaabdu4/wadigest}"
PIN_TAG="wacli-fork-v0.22.0"
install_pin_release() {
  local tmp name want got base="https://github.com/$PIN_REPO/releases/download/$PIN_TAG"
  name="wacli-pin_${PLATFORM}_${GOARCH}.tar.gz"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/$name" "$base/$name" && curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt" || { rm -rf "$tmp"; return 1; }
  want="$(grep " ${name}\$" "$tmp/checksums.txt" | awk '{print $1}')"
  if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/$name" | awk '{print $1}')"; else got="$(shasum -a 256 "$tmp/$name" | awk '{print $1}')"; fi
  [ -n "$want" ] && [ "$want" = "$got" ] || { rm -rf "$tmp"; warn "The pinning download failed its checksum check, not using it."; return 1; }
  tar -xzf "$tmp/$name" -C "$tmp"
  [ "$PLATFORM" = darwin ] && xattr -d com.apple.quarantine "$tmp/wacli" 2>/dev/null || true
  "$tmp/wacli" messages pin --help 2>/dev/null | grep -qi unpin || { rm -rf "$tmp"; return 1; }
  rm -f "$BIN_DIR/wacli" && install -m 0755 "$tmp/wacli" "$BIN_DIR/wacli"
  rm -rf "$tmp"
}
wacli_version() { "$1" --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1; }
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
MIN_WACLI=0.22.0
WACLI=""
for cand in "$BIN_DIR/wacli" "$(command -v wacli 2>/dev/null || true)"; do
  if [ -n "$cand" ] && [ -x "$cand" ]; then
    v="$(wacli_version "$cand" || true)"
    if [ -n "$v" ] && version_ge "$v" "$MIN_WACLI"; then WACLI="$cand"; break; fi
  fi
done

install_wacli_release() {
  say "Downloading wacli from GitHub releases"
  local api tag ver tmp asset url
  api="$(curl -fsSL https://api.github.com/repos/openclaw/wacli/releases/latest)" || return 1
  tag="$(printf '%s' "$api" | grep -Eo '"tag_name": *"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
  [ -n "$tag" ] || return 1
  ver="${tag#v}"
  tmp="$(mktemp -d)"
  for name in "wacli_${ver}_${PLATFORM}_${GOARCH}.tar.gz" "wacli_${ver}_${PLATFORM}_universal.tar.gz"; do
    url="https://github.com/openclaw/wacli/releases/download/${tag}/${name}"
    if curl -fsSL -o "$tmp/$name" "$url"; then asset="$name"; break; fi
  done
  [ -n "${asset:-}" ] || { rm -rf "$tmp"; return 1; }
  curl -fsSL -o "$tmp/checksums.txt" "https://github.com/openclaw/wacli/releases/download/${tag}/checksums.txt" || { rm -rf "$tmp"; return 1; }
  local want got
  want="$(grep " ${asset}\$" "$tmp/checksums.txt" | awk '{print $1}')"
  if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/$asset" | awk '{print $1}')"; else got="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"; fi
  [ -n "$want" ] && [ "$want" = "$got" ] || { rm -rf "$tmp"; die "wacli download failed its checksum check, not installing it."; }
  tar -xzf "$tmp/$asset" -C "$tmp"
  install -m 0755 "$(find "$tmp" -type f -name wacli | head -1)" "$BIN_DIR/wacli"
  [ "$PLATFORM" = darwin ] && xattr -d com.apple.quarantine "$BIN_DIR/wacli" 2>/dev/null || true
  rm -rf "$tmp"
  WACLI="$BIN_DIR/wacli"
}

if [ -n "$WACLI" ]; then
  ok "wacli $(wacli_version "$WACLI") ($WACLI)"
elif [ "$WITH_PIN" = 1 ] && say "Downloading wacli with message pinning" && install_pin_release; then
  WACLI="$BIN_DIR/wacli"
  ok "wacli $(wacli_version "$WACLI") with pinning ($WACLI)"
else
  if [ "$HAVE_BREW" = 1 ]; then
    say "Installing wacli with Homebrew (openclaw/tap/wacli)"
    if brew install openclaw/tap/wacli; then WACLI="$(command -v wacli)"; fi
  fi
  if [ -z "$WACLI" ]; then install_wacli_release || die "Couldn't install wacli. Install it by hand (brew install openclaw/tap/wacli) and run this again."; fi
  ok "wacli $(wacli_version "$WACLI") ($WACLI)"
fi
# Pin the wacli we found so the background service uses the same one.
if [ "$WACLI" != "$BIN_DIR/wacli" ]; then rm -f "$BIN_DIR/wacli"; cp "$WACLI" "$BIN_DIR/wacli"; chmod +x "$BIN_DIR/wacli"; fi

# ---------- 2b. message pinning (wadigest build of wacli) ----------
if [ "$WITH_PIN" = 1 ] && ! "$BIN_DIR/wacli" messages pin --help 2>/dev/null | grep -qi "unpin" && install_pin_release; then
  ok "pinning ready"
fi
if [ "$WITH_PIN" = 1 ] && ! "$BIN_DIR/wacli" messages pin --help 2>/dev/null | grep -qi "unpin"; then
  say "Adding message pinning (builds wacli with a pin command, a few minutes)"
  if ! command -v go >/dev/null 2>&1 && [ "$HAVE_BREW" = 1 ]; then brew install go || true; fi
  if command -v go >/dev/null 2>&1; then
    if bash "$APP_DIR/wacli-fork/build.sh" "$BIN_DIR/wacli.pin" >"$WD_HOME/logs/wacli-build.log" 2>&1; then
      rm -f "$BIN_DIR/wacli" && mv "$BIN_DIR/wacli.pin" "$BIN_DIR/wacli"
      ok "pinning ready"
    else
      warn "Couldn't build it (details: $WD_HOME/logs/wacli-build.log). Everything else works; pin the digest by hand."
    fi
  else
    warn "Go isn't installed, so pinning is skipped (install Go from https://go.dev/dl and re-run this). Everything else works."
  fi
fi

# ---------- 3. optional video tools ----------
if [ "$WITH_VIDEO" = 1 ]; then
  say "Installing video transcription (ffmpeg + whisper.cpp)"
  if [ "$HAVE_BREW" = 1 ]; then
    command -v ffmpeg >/dev/null 2>&1 || brew install ffmpeg
    command -v whisper-cli >/dev/null 2>&1 || brew install whisper-cpp
  else
    command -v ffmpeg >/dev/null 2>&1 || warn "Install ffmpeg with your package manager (e.g. sudo apt install ffmpeg)"
    command -v whisper-cli >/dev/null 2>&1 || warn "Install whisper.cpp (whisper-cli) or 'pip install openai-whisper'"
  fi
  MODEL="$WD_HOME/models/ggml-base.bin"
  if [ ! -s "$MODEL" ]; then
    mkdir -p "$WD_HOME/models"
    say "Downloading the Whisper base model (~150 MB, multilingual)"
    curl -fL --progress-bar -o "$MODEL.part" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin && mv "$MODEL.part" "$MODEL"
  fi
  ok "video transcription ready"
fi

date -u +%Y-%m-%dT%H:%M:%SZ > "$WD_HOME/installed"
if [ "$FROM_UI" = 1 ]; then ok "All set"; exit 0; fi

# If the service is already installed, restart it so it runs the new code.
if [ "$PLATFORM" = darwin ] && [ -f "$HOME/Library/LaunchAgents/com.wadigest.daemon.plist" ]; then
  "$BIN_DIR/wadigest" service install >/dev/null && ok "background service restarted"
elif [ "$PLATFORM" = linux ] && [ -f "$HOME/.config/systemd/user/wadigest.service" ]; then
  "$BIN_DIR/wadigest" service install >/dev/null && ok "background service restarted"
fi

if [ "$RUN_SETUP" = 1 ]; then
  echo
  echo
  say "Opening setup"
  "$BIN_DIR/wadigest" setup ${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"}
else
  say "Checking"
  "$BIN_DIR/wadigest" doctor || true
  echo
  say "Installed. Next: wadigest setup  (open a new terminal first, or run: export PATH=\"$BIN_DIR:\$PATH\")"
fi
