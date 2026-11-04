#!/usr/bin/env bash
# Regenerates vendor/buzz-author-0.0.0-preview.1.tgz (type-only @buzz/author)
# from block/buzz-app at REF (default: main). Needs git, Node and pnpm.
set -euo pipefail
REF="${1:-main}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
git clone --quiet --filter=blob:none https://github.com/block/buzz-app "$WORK/buzz-app"
git -C "$WORK/buzz-app" checkout --quiet "$REF"
(cd "$WORK/buzz-app" && CI=true pnpm install --ignore-scripts >/dev/null && pnpm author:build >/dev/null)
(cd "$WORK/buzz-app/dist-author" && npm pack --silent --pack-destination "$ROOT/vendor" >/dev/null)
echo "Updated vendor/ from block/buzz-app@$(git -C "$WORK/buzz-app" rev-parse --short HEAD)"
