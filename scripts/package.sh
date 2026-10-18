#!/usr/bin/env bash
# Builds release/wadigest-<version>.zip and .tar.gz: what you send to other people.
set -euo pipefail
cd "$(dirname "$0")/.."
V="$(node -p 'require("./package.json").version')"
NAME="wadigest-$V"
rm -rf release && mkdir -p "release/$NAME"
cp -R bin src scripts wacli-fork package.json README.md START-HERE.md LICENSE "Start wadigest.command" "Start wadigest.cmd" "release/$NAME/"
rm -f "release/$NAME/scripts/package.sh"
(cd release && tar -czf "$NAME.tar.gz" "$NAME" && (command -v zip >/dev/null && zip -qr "$NAME.zip" "$NAME" || true))
echo "Built: $(ls release/*.tar.gz release/*.zip 2>/dev/null | tr '\n' ' ')"
echo "Recipients: unzip, open START-HERE.md, double-click Start wadigest"
