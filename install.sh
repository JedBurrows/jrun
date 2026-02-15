#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/.local/bin"
LINK_NAME="$INSTALL_DIR/jrun"

# 1. Ensure jrun.sh is executable
chmod +x "$SCRIPT_DIR/jrun.sh"

# 2. Create ~/.local/bin/ if needed
mkdir -p "$INSTALL_DIR"

# 3. Symlink jrun.sh → ~/.local/bin/jrun
ln -sf "$SCRIPT_DIR/jrun.sh" "$LINK_NAME"
echo "Linked $LINK_NAME → $SCRIPT_DIR/jrun.sh"

# 4. Check if ~/.local/bin is on PATH; if not, add it to ~/.bashrc
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
  echo "Added ~/.local/bin to PATH in ~/.bashrc"
  echo "Run 'source ~/.bashrc' to update your current shell."
else
  echo "~/.local/bin is already on PATH. You're good to go!"
fi
