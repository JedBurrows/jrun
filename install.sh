#!/usr/bin/env bash
set -euo pipefail

REPO="jedburrows/jrun"
BINARY_NAME="jrun"
STATE_DIR="$HOME/.jrun"

# --- helpers ---

die() { echo "Error: $1" >&2; exit 1; }

detect_install_dir() {
  if [ -d "$HOME/.local/bin" ] && echo "$PATH" | grep -q "$HOME/.local/bin"; then
    echo "$HOME/.local/bin"
  elif [ -w "/usr/local/bin" ]; then
    echo "/usr/local/bin"
  else
    echo "$HOME/.local/bin"
  fi
}

# --- uninstall ---

do_uninstall() {
  local install_dir
  # find where jrun is installed
  install_dir="$(dirname "$(command -v "$BINARY_NAME" 2>/dev/null)" || true)"

  if [ -z "$install_dir" ] || [ ! -f "$install_dir/$BINARY_NAME" ]; then
    # check common locations
    for dir in "$HOME/.local/bin" "/usr/local/bin"; do
      if [ -f "$dir/$BINARY_NAME" ]; then
        install_dir="$dir"
        break
      fi
    done
  fi

  if [ -n "$install_dir" ] && [ -f "$install_dir/$BINARY_NAME" ]; then
    echo "Removing $install_dir/$BINARY_NAME..."
    rm -f "$install_dir/$BINARY_NAME" 2>/dev/null || sudo rm -f "$install_dir/$BINARY_NAME"
    echo "Binary removed."
  else
    echo "jrun binary not found, nothing to remove."
  fi

  if [ -d "$STATE_DIR" ]; then
    printf "Remove state directory %s? [y/N] " "$STATE_DIR"
    read -r answer
    if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
      rm -rf "$STATE_DIR"
      echo "State directory removed."
    else
      echo "State directory kept."
    fi
  fi

  echo "Uninstall complete."
  exit 0
}

# --- install ---

do_install() {
  # detect platform
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$os" in
    linux) ;;
    *) die "Unsupported OS: $os. Only Linux is currently supported." ;;
  esac

  case "$arch" in
    x86_64|amd64) ;;
    *) die "Unsupported architecture: $arch. Only x86_64 is currently supported." ;;
  esac

  # get latest release download URL
  local download_url
  download_url="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep '"browser_download_url"' \
    | grep -o 'https://[^"]*' \
    | head -1)" || die "Failed to fetch latest release. Check your internet connection."

  [ -n "$download_url" ] || die "No binary found in latest release."

  local install_dir
  install_dir="$(detect_install_dir)"
  mkdir -p "$install_dir"

  echo "Downloading jrun..."
  curl -fsSL "$download_url" -o "$install_dir/$BINARY_NAME" || die "Download failed."
  chmod +x "$install_dir/$BINARY_NAME"

  echo "Installed jrun to $install_dir/$BINARY_NAME"

  # check PATH
  if ! echo "$PATH" | grep -q "$install_dir"; then
    echo ""
    echo "NOTE: $install_dir is not on your PATH."
    echo "Add this to your shell profile:"
    echo "  export PATH=\"$install_dir:\$PATH\""
  fi

  echo ""
  echo "Run 'jrun --help' to get started."
}

# --- main ---

case "${1:-}" in
  --uninstall) do_uninstall ;;
  --help|-h)
    echo "Usage: install.sh [--uninstall]"
    echo ""
    echo "  (default)     Install the latest jrun binary"
    echo "  --uninstall   Remove jrun and optionally its state"
    exit 0
    ;;
  "") do_install ;;
  *) die "Unknown option: $1. Use --help for usage." ;;
esac
