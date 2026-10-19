# 9Router + Codex dotfiles

Enable this repository in GitHub Settings > Codespaces > Dotfiles and choose automatic installation. The installer installs the pinned 9Router and Codex CLIs, restores the Codex provider configuration, imports `NINE_ROUTER_BACKUP_BASE64` when GitHub supplies that Codespaces Secret, and starts the local gateway. Shell startup also restores the gateway after Codespaces restarts.

Run `bash install.sh` manually to repair an existing Codespace, then use **Developer: Reload Window** if the VS Code Codex panel was already open. The `9router` command remains available from any project directory. Never commit the backup or its decoded contents.
