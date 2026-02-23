# pi-extmgr

![pi-extmgr banner](https://i.imgur.com/Ce513Br.png)

[![CI](https://github.com/ayagmar/pi-extmgr/actions/workflows/ci.yml/badge.svg)](https://github.com/ayagmar/pi-extmgr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A better way to manage Pi extensions. Browse, install, enable/disable, and remove extensions from one place.

**🌐 [pi-extmgr landing page](https://ayagmar.github.io/pi-extmgr)**

## Install

```bash
pi install npm:pi-extmgr
```

Then reload Pi.

## Features

- **Unified manager UI**
  - Local extensions (`~/.pi/agent/extensions`, `.pi/extensions`) and installed packages in one list
  - Scope indicators (global/project), status indicators, update badges
- **Package extension configuration panel**
  - Configure individual extension entrypoints inside an installed package (`c` on package row)
  - Persists to package filters in `settings.json` (no manual JSON editing)
- **Safe staged local extension toggles**
  - Toggle with `Space/Enter`, apply with `S`
  - Unsaved-change guard when leaving (save/discard/stay)
- **Package management**
  - Install, update, remove from UI and command line
  - Quick actions (`A`, `u`, `X`) and bulk update (`U`)
- **Remote discovery and install**
  - npm search/browse with pagination
  - Install by source (`npm:`, `git:`, `https://`, `ssh://`, `git@...`, local path)
  - Supports direct GitHub `.ts` installs and local standalone install mode
- **Auto-update**
  - Interactive wizard (`t` in manager, or `/extensions auto-update`)
  - Persistent schedule restored on startup and session switch
  - Background checks + status bar updates
- **Operational visibility**
  - Session history (`/extensions history`)
  - Cache controls (`/extensions clear-cache`)
  - Status line summary (`pkg count • auto-update • known updates`)
- **Interactive + non-interactive support**
  - Works in TUI and non-UI modes
  - Non-interactive commands for list/install/remove/update/auto-update

## Usage

Open the manager:

```
/extensions
```

### In the manager

| Key           | Action                                                |
| ------------- | ----------------------------------------------------- |
| `↑↓`          | Navigate                                              |
| `Space/Enter` | Toggle local extension on/off                         |
| `S`           | Save local extension changes                          |
| `Enter` / `A` | Actions on selected package (configure/update/remove) |
| `c`           | Configure selected package extensions                 |
| `u`           | Update selected package directly                      |
| `X`           | Remove selected item (package/local extension)        |
| `i`           | Quick install by source                               |
| `f`           | Quick search                                          |
| `U`           | Update all packages                                   |
| `t`           | Auto-update wizard                                    |
| `P` / `M`     | Quick actions palette                                 |
| `R`           | Browse remote packages                                |
| `?` / `H`     | Help                                                  |
| `Esc`         | Exit                                                  |

### Commands

```bash
/extensions                      # Open interactive manager (default)
/extensions local                # Alias: open interactive manager
/extensions list                 # List local extensions
/extensions remote               # Open remote package browser
/extensions packages             # Alias: remote browser
/extensions installed            # Installed packages view (legacy alias to unified flow)
/extensions search <query>       # Search npm packages
/extensions install <source> [--project|--global]  # Install package
/extensions remove [source]      # Remove package
/extensions uninstall [source]   # Alias: remove
/extensions update [source]      # Update one package (or all when omitted)
/extensions auto-update [every]  # No arg opens wizard in UI; accepts 1d, 1w, never, etc.
/extensions history [options]    # View change history (supports filters)
/extensions clear-cache          # Clear metadata cache
```

### Non-interactive mode

When Pi is running without UI, extmgr still supports command-driven workflows:

- `/extensions list`
- `/extensions installed`
- `/extensions install <source> [--project|--global]`
- `/extensions remove <source>`
- `/extensions update [source]`
- `/extensions history [options]`
- `/extensions auto-update <duration>`

Remote browsing/search menus require interactive mode.

History options (works in non-interactive mode too):

- `--limit <n>`
- `--action <extension_toggle|package_install|package_update|package_remove|cache_clear>`
- `--success` / `--failed`
- `--package <query>`
- `--since <duration>` (e.g. `30m`, `24h`, `7d`, `1mo`)
- `--global` (non-interactive mode only; reads all persisted sessions)

Examples:

- `/extensions history --failed --limit 50`
- `/extensions history --action package_update --since 7d`
- `/extensions history --global --package extmgr --since 24h`

### Install sources

```bash
/extensions install npm:package-name
/extensions install @scope/package
/extensions install git:https://github.com/user/repo.git
/extensions install git:git@github.com:user/repo.git
/extensions install ssh://git@github.com/user/repo.git
/extensions install https://github.com/user/repo/blob/main/extension.ts
/extensions install /path/to/extension.ts
/extensions install ./local-folder/
```

## Tips

- **Staged local changes**: Toggle local extensions on/off, then press `S` to apply all at once.
- **Package extension config**: Select a package and press `c` (or Enter/A → Configure) to enable/disable individual package entrypoints.
  - After saving package extension config, restart pi to fully apply changes.
- **Two install modes**:
  - **Managed** (npm): Auto-updates with `pi update`, stored in pi's package cache
  - **Local** (standalone): Copies to `~/.pi/agent/extensions/{package}/`, supports multi-file extensions
- **Auto-update schedule is persistent**: `/extensions auto-update 1d` stays active across future Pi sessions and is restored when switching sessions.
- **Settings/cache writes are hardened**: extmgr serializes writes and uses safe file replacement to reduce JSON corruption issues.
- **Invalid JSON is handled safely**: malformed `auto-update.json` / metadata cache files are backed up and reset; invalid `.pi/settings.json` is not overwritten during package-extension toggles.
- **Reload is built-in**: When extmgr asks to reload, it calls `ctx.reload()` directly.

## License

MIT
