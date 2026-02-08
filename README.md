# pi-extmgr

<img width="2560" height="369" alt="image" src="https://i.imgur.com/7ifGp5x.png" />

[![CI](https://github.com/ayagmar/pi-extmgr/actions/workflows/ci.yml/badge.svg)](https://github.com/ayagmar/pi-extmgr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A better way to manage Pi extensions. Browse, install, enable/disable, and remove extensions from one place.

## Install

```bash
pi install npm:pi-extmgr
```

Then reload Pi with `/reload`.

## What it does

- **Unified view**: See all your local extensions and installed npm/git packages in one list
- **Toggle extensions**: Enable/disable local extensions with Space/Enter, save with `S`
- **Package actions**: Update or remove installed packages with `A`
- **Browse community**: Search and install from npm (`R` to browse)
- **History tracking**: See what you've changed with `/extensions history`

## Usage

Open the manager:

```
/extensions
```

### In the manager

| Key           | Action                                           |
| ------------- | ------------------------------------------------ |
| `↑↓`          | Navigate                                         |
| `Space/Enter` | Toggle local extension on/off                    |
| `S`           | Save changes                                     |
| `Enter` / `A` | Actions on selected package (update/remove/view) |
| `u`           | Update selected package directly                 |
| `X`           | Remove selected package directly                 |
| `i`           | Quick install by source                          |
| `f`           | Quick search                                     |
| `U`           | Update all packages                              |
| `t`           | Auto-update wizard                               |
| `R`           | Browse remote packages                           |
| `?` / `H`     | Help                                             |
| `Esc`         | Exit                                             |

### Commands

```bash
/extensions                      # Open the manager
/extensions search <query>       # Search npm
/extensions install <source>     # Install package
/extensions remove [source]      # Remove package
/extensions update [source]      # Update one package (or all when omitted)
/extensions auto-update [every]  # No arg opens wizard; accepts 1d, 1w, never, etc.
/extensions history              # View change history
/extensions stats                # View statistics
/extensions clear-cache          # Clear metadata cache
```

### Install sources

```bash
/extensions install npm:package-name
/extensions install @scope/package
/extensions install git:https://github.com/user/repo.git
/extensions install https://github.com/user/repo/blob/main/extension.ts
/extensions install /path/to/extension.ts
/extensions install ./local-folder/
```

## Tips

- **Staged changes**: Toggle extensions on/off, then press `S` to apply all at once. A `*` shows pending changes.
- **Two install modes**:
  - **Managed** (npm): Auto-updates with `pi update`, stored in pi's package cache
  - **Local** (standalone): Copies to `~/.pi/agent/extensions/{package}/`, supports multi-file extensions
- **Auto-update schedule is persistent**: `/extensions auto-update 1d` stays active across future Pi sessions.
- **Remove requires restart**: After removing a package, you need to fully restart Pi (not just `/reload`) for it to be completely unloaded.

## Keyboard shortcut

Press `Ctrl+Shift+E` anywhere to open the extension manager.

## License

MIT
