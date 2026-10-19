#!/usr/bin/env bash
set -euo pipefail

AI_TOOLS_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
AI_TOOLS_NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if (( AI_TOOLS_NODE_MAJOR < 24 )); then
  for AI_TOOLS_NVM_SCRIPT in "${NVM_DIR:-$HOME/.nvm}/nvm.sh" /usr/local/share/nvm/nvm.sh; do
    if [[ -s "$AI_TOOLS_NVM_SCRIPT" ]]; then
      source "$AI_TOOLS_NVM_SCRIPT"
      break
    fi
  done
  if ! command -v nvm >/dev/null 2>&1; then
    echo 'Node.js 24+ diperlukan untuk memasang 9Router dan Codex.' >&2
    exit 1
  fi
  nvm install 24
  nvm use 24
fi
# Restore the persistent account and start the gateway during Codespaces
# dotfiles setup. Without the second step, the Codex extension starts before
# its local provider is listening and falls back to the ChatGPT sign-in view.
node "$AI_TOOLS_SCRIPT_DIR/ensure-9router.cjs" run
