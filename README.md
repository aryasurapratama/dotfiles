# 9Router + Codex dotfiles

Enable this repository in GitHub Settings > Codespaces > Dotfiles and choose automatic installation. The installer installs the pinned 9Router and Codex CLIs, restores the Codex provider configuration, and imports `NINE_ROUTER_BACKUP_BASE64` when GitHub supplies that Codespaces Secret.

Run `bash install.sh` manually to repair an existing Codespace. After installation, run `9router` in a new terminal from any project directory, then use **Developer: Reload Window** if the VS Code Codex panel was already open. Never commit the backup or its decoded contents.
