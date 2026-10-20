#!/usr/bin/env bash
set -euo pipefail

repo="${CIRCLE_REPO:-circle-platforms/circle}"
temporary=""
cleanup() { [[ -z "$temporary" ]] || rm -rf -- "$temporary"; }
trap cleanup EXIT
circle_zh() {
  case "${LC_ALL:-${LANG:-}}" in
    zh*|zh_*) return 0 ;;
    *) return 1 ;;
  esac
}
circle_line() {
  local text=$1
  if ! circle_zh; then printf '%s' "$text"; return; fi
  case "$text" in
    'verifying the download') printf '%s' '正在校验下载' ;;
    unpacking) printf '%s' '正在解压' ;;
    downloading\ *) printf '%s' "正在下载 ${text#downloading }" ;;
    'Missing command: '*) printf '%s' "缺少命令：${text#Missing command: }" ;;
    'Invalid repository') printf '%s' '仓库名无效' ;;
    'Run install.ps1 from PowerShell') printf '%s' '请在 PowerShell 里运行 install.ps1' ;;
    'Unsupported operating system') printf '%s' '不支持的操作系统' ;;
    'Unsupported architecture') printf '%s' '不支持的处理器架构' ;;
    'No release has been published yet') printf '%s' '还没有发布' ;;
    'Invalid semantic version') printf '%s' '版本号不是合法的语义化版本' ;;
    'Invalid checksum receipt') printf '%s' '校验和文件无效' ;;
    'sha256sum or shasum is required') printf '%s' '需要 sha256sum 或 shasum' ;;
    'Archive checksum mismatch') printf '%s' '压缩包校验和不匹配' ;;
    'Unexpected archive root') printf '%s' '压缩包的根目录不对' ;;
    'Unsafe archive entry') printf '%s' '压缩包里有不安全的路径' ;;
    'Archive links and special files are not allowed') printf '%s' '不允许压缩包里有链接或特殊文件' ;;
    'Incomplete release') printf '%s' '发布不完整' ;;
    *) printf '%s' "$text" ;;
  esac
}
fail() { printf '[circle-install] %s\n' "$(circle_line "$*")" >&2; exit 1; }
say() { printf '[circle-install] %s\n' "$(circle_line "$*")"; }
for command in curl tar; do command -v "$command" >/dev/null || fail "Missing command: $command"; done
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'Invalid repository'

case "$(uname -s)" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  MINGW*|MSYS*|CYGWIN*)
    command -v powershell.exe >/dev/null || fail 'Run install.ps1 from PowerShell'
    exec powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm 'https://raw.githubusercontent.com/$repo/main/install.ps1' | iex" ;;
  *) fail 'Unsupported operating system' ;;
esac
case "$(uname -m)" in x86_64|amd64) architecture=x64 ;; arm64|aarch64) architecture=arm64 ;; *) fail 'Unsupported architecture' ;; esac
version="${CIRCLE_VERSION:-}"
if [[ -z "$version" ]]; then
  latest="$(curl --proto '=https' --tlsv1.2 -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest")"
  [[ "$latest" == */releases/tag/* ]] || fail 'No release has been published yet'
  version="${latest##*/}"
fi
version="${version#v}"
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]] || fail 'Invalid semantic version'
asset="circle-$version-$platform-$architecture.tar.gz"
temporary="$(mktemp -d)"
archive="$temporary/$asset"
if [[ -n "${CIRCLE_ASSET_DIR:-}" ]]; then
  cp -- "$CIRCLE_ASSET_DIR/$asset" "$archive"
  cp -- "$CIRCLE_ASSET_DIR/$asset.sha256" "$archive.sha256"
else
  base="https://github.com/$repo/releases/download/v$version"
  say "downloading $asset"
  # A bar of how far it has got, on a terminal.
  if [[ -t 2 ]]; then progress=(--progress-bar); else progress=(-s); fi
  curl --proto '=https' --tlsv1.2 -fSL "${progress[@]}" "$base/$asset" -o "$archive"
  curl --proto '=https' --tlsv1.2 -fsSL "$base/$asset.sha256" -o "$archive.sha256"
fi
say 'verifying the download'
expected="$(awk -v name="$asset" '$2 == name && length($1) == 64 { print $1 }' "$archive.sha256")"
[[ "$expected" =~ ^[0-9a-fA-F]{64}$ ]] || fail 'Invalid checksum receipt'
if command -v sha256sum >/dev/null; then actual="$(sha256sum "$archive" | awk '{print $1}')"
elif command -v shasum >/dev/null; then actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
else fail 'sha256sum or shasum is required'; fi
[[ "$actual" == "$expected" ]] || fail 'Archive checksum mismatch'
tar -tzf "$archive" > "$temporary/entries"
while IFS= read -r entry; do
  [[ "$entry" == circle || "$entry" == circle/ || "$entry" == circle/* ]] || fail 'Unexpected archive root'
  [[ "$entry" != /* && "/$entry/" != */../* ]] || fail 'Unsafe archive entry'
done < "$temporary/entries"
tar -tvzf "$archive" > "$temporary/types"
while IFS= read -r entry; do [[ "${entry:0:1}" == '-' || "${entry:0:1}" == 'd' ]] || fail 'Archive links and special files are not allowed'; done < "$temporary/types"
say 'unpacking'
tar -xzf "$archive" -C "$temporary"
root="$temporary/circle"
[[ -x "$root/runtime/node" && -f "$root/app/dist/install_manager.js" ]] || fail 'Incomplete release'
"$root/runtime/node" --input-type=module -e 'import fs from "node:fs"; const m=JSON.parse(fs.readFileSync(process.argv[1])); if(m.version!==process.argv[2])throw Error("Release version mismatch");' "$root/release.json" "$version"
# Installs into CIRCLE_PREFIX and CIRCLE_BIN_DIR when they are set, otherwise into
# ~/.local/share/circle and ~/.local/bin.
CIRCLE_REPO="$repo" "$root/runtime/node" "$root/app/dist/install_manager.js" "$root"
