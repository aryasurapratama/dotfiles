#!/usr/bin/env bash
set -euo pipefail
AI_TOOLS_DOTFILES_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$AI_TOOLS_DOTFILES_DIR/scripts/install-ai-tools.sh"
