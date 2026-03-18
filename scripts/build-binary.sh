#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

NODE_VERSION="$(node -e 'console.log(process.version)')"

echo "==> Building CJS bundle for SEA..."
pnpm build:sea

echo "==> Generating SEA blob..."
node --experimental-sea-config sea-config.json

# The system node binary may be stripped (missing SEA fuse sentinel).
# Download an official unstripped binary if needed.
get_node_binary() {
  local node_bin="$(which node)"
  if strings "$node_bin" 2>/dev/null | grep -q NODE_SEA_FUSE; then
    echo "$node_bin"
    return
  fi

  echo "    System node binary is stripped, downloading official binary..." >&2
  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac

  local os
  case "$(uname -s)" in
    Linux) os="linux" ;;
    Darwin) os="darwin" ;;
    *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
  esac

  local tarball="node-${NODE_VERSION}-${os}-${arch}.tar.xz"
  local url="https://nodejs.org/dist/${NODE_VERSION}/${tarball}"
  local tmp_dir="$(mktemp -d)"

  curl -fsSL "$url" | tar -xJ -C "$tmp_dir" --strip-components=1 "node-${NODE_VERSION}-${os}-${arch}/bin/node"
  echo "$tmp_dir/bin/node"
}

echo "==> Copying node binary..."
NODE_BIN="$(get_node_binary)"
cp "$NODE_BIN" dist/jrun

echo "==> Injecting SEA blob into binary..."
npx postject dist/jrun NODE_SEA_BLOB dist/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# Note: do not strip the binary — stripping after postject injection causes segfaults

echo "==> Done! Binary at dist/jrun ($(du -h dist/jrun | cut -f1))"
