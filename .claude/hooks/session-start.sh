#!/bin/bash
# Prepares a Claude Code cloud session: Circle needs Node.js 24, the image ships an older one.
# Installs the Node.js that the release workflow pins, the root, workbench and desktop
# dependencies, and Electron's binary, which the desktop tests start under Xvfb.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

NODE_VERSION=v24.21.0
NODE_DIR=/opt/node24
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

if [ "$("$NODE_DIR/bin/node" --version 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  work="$(mktemp -d)"
  archive="node-$NODE_VERSION-linux-x64.tar.xz"
  curl -sSfL -o "$work/$archive" "https://nodejs.org/dist/$NODE_VERSION/$archive"
  curl -sSfL -o "$work/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  (cd "$work" && grep " $archive\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xJf "$work/$archive" -C "$NODE_DIR" --strip-components=1
  rm -rf "$work"
fi
export PATH="$NODE_DIR/bin:$PATH"
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$NODE_DIR/bin:\$PATH\"" >>"$CLAUDE_ENV_FILE"
fi

# npm ci only when the lock file changed since the last install, so a cached container starts fast
install() {
  local dir="$1"
  if [ ! -f "$dir/node_modules/.package-lock.json" ] ||
    [ "$dir/package-lock.json" -nt "$dir/node_modules/.package-lock.json" ]; then
    npm --prefix "$dir" ci --no-audit --no-fund
  fi
}
install "$ROOT"
install "$ROOT/apps/workbench"
install "$ROOT/apps/desktop"

if [ ! -x "$ROOT/apps/desktop/node_modules/electron/dist/electron" ]; then
  (cd "$ROOT/apps/desktop" && node node_modules/electron/install.js)
fi
