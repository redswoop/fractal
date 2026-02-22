#!/usr/bin/env bash
# Install fractal redline keybindings into VS Code user config.
# Called by devcontainer postAttachCommand.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/keybindings.json"
DEST="${HOME}/.vscode-server/data/Machine/keybindings.json"

mkdir -p "$(dirname "$DEST")"
cp "$SRC" "$DEST"
