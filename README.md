# 🔧 pi-extmgr

<img width="2560" height="369" alt="image" src="https://i.imgur.com/nP5rJPC.png" />

> Enhanced UI/UX for managing Pi extensions and discovering community packages

[![CI](https://github.com/ayagmar/pi-extmgr/actions/workflows/ci.yml/badge.svg)](https://github.com/ayagmar/pi-extmgr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**pi-extmgr** transforms extension management in Pi from a command-line chore into a delightful interactive experience. Browse, install, and manage extensions with an intuitive TUI interface, smart autocomplete, and one-click operations.

<!-- Replace with actual demo GIF/Screenshot when available -->
<!-- ![Demo](demo.gif) -->

## ✨ Features

### 🎨 Interactive TUI Interface

- **Beautiful themed interface** with color-coded status indicators
- **Unified view** - local extensions and npm/git packages in one screen
- **Keyboard-driven navigation** - fast and efficient
- **Real-time previews** with package descriptions
- **Context-aware help** - press `?` anywhere for shortcuts

### 📋 Unified Extension Manager

All your extensions in one place:

- **Local extensions**: `● enabled` / `○ disabled` with `[G]` global or `[P]` project scope
- **Installed packages**: `📦` icon with name@version
- **Visual distinction** between toggle-able locals and action-based packages
- **Smart deduplication** - packages already managed as local extensions are hidden

### 🔍 Smart Package Discovery

- **Browse community packages** with pagination (20 per page)
- **Cached search results** for lightning-fast navigation
- **Keyword filtering** - automatically shows `pi-package` tagged npm packages
- **Detailed package info** - view version, author, homepage

### 📦 Flexible Installation

- **Multiple source support**: npm, git, local paths
- **Two install modes**:
  - **Managed** (npm) - Auto-updates with `pi update`, stored in pi's package cache
  - **Standalone** (local) - Full package directory to `~/.pi/agent/extensions/{package}/`
- **Multi-file extension support** - Local install copies entire package directory, preserving imports
- **Auto-extract** from npm tarballs for local installs
- **One-click reload** after installation

### ⚡ Quick Extension Management

- **Enable/disable extensions** with staging (preview before applying)
- **Package actions** - update/remove/view details without leaving the manager
- **Visual change indicators** (`*`) show pending modifications
- **Bulk operations** - update all packages at once
- **Scope indicators**: Global (G) vs Project (P) for all items

### 🎯 Quality of Life

- **Tab autocomplete** for all subcommands
- **Status bar integration** - shows installed package count
- **Keyboard shortcut**: `Ctrl+Shift+E` opens extension manager
- **Non-interactive mode** - works in scripts and CI
- **Parallel data loading** - local extensions and packages fetched simultaneously

## 🚀 Installation

```bash
pi install npm:pi-extmgr
```

Then reload Pi:

```
/reload
```

## 📖 Usage

### Interactive Mode (Recommended)

```
/extensions              # Open unified interactive manager
```

The unified view displays:

- **Local extensions** first (toggle-able)
- **Installed packages** second (action-based)
- Sorted alphabetically within each group

#### Keyboard Shortcuts

| Key           | Action                                              |
| ------------- | --------------------------------------------------- |
| `↑↓`          | Navigate items                                      |
| `Space/Enter` | Toggle local extension on/off                       |
| `S`           | Save changes to local extensions                    |
| `A`           | Actions on selected package (update/remove/details) |
| `R`           | Browse remote packages                              |
| `?` / `H`     | Show help                                           |
| `Esc`         | Cancel / Exit                                       |

**Staged Changes**: Toggle extensions on/off without immediate effect. Press `S` to apply all changes at once. Pending changes show `*` next to the extension name.

#### Package Actions

When a package is selected, press `A` to:

- **Update package** - fetch latest version
- **Remove package** - uninstall completely
- **View details** - see version, source, scope
- **Back to manager** - return to unified view

#### Community Package Browser

Browse and install from npm:

| Key     | Action               |
| ------- | -------------------- |
| `↑↓`    | Navigate packages    |
| `Enter` | View package details |
| `N`     | Next page            |
| `P`     | Previous page        |
| `R`     | Refresh search       |
| `Esc`   | Cancel               |

### Command Reference

```bash
# Unified Manager (Recommended)
/extensions                   # Open unified interactive manager

# Legacy Commands
/extensions list              # List local extensions (text output)
/extensions installed         # Redirects to unified view

# Package Discovery
/extensions remote            # Browse community packages
/extensions packages          # Alias for remote
/extensions search <query>    # Search npm for packages

# Package Management
/extensions install <source>  # Install from npm/git/path
/extensions remove [source]   # Remove package (interactive if no source)
/extensions uninstall [source]# Alias for remove
```

### Install Sources

```bash
# npm packages (auto-detected if no prefix)
/extensions install npm:some-package
/extensions install @scope/package

# Git repositories
/extensions install git:https://github.com/user/repo.git

# GitHub single-file extensions (.ts files)
# Automatically converts blob URLs to raw and downloads directly
/extensions install https://github.com/user/repo/blob/main/extension.ts

# Local paths
/extensions install /path/to/extension.ts
/extensions install ./my-extension/
```

### Non-Interactive Mode

All commands work in non-interactive environments (CI, scripts):

```bash
# These work without UI
/extensions list
/extensions installed

# These require arguments in non-interactive mode
/extensions install npm:package-name
/extensions remove npm:package-name
```

## 🎮 Keyboard Shortcuts

### Global

- `Ctrl+Shift+E` - Open Extensions Manager

### In Unified Manager

| Key            | Action                          |
| -------------- | ------------------------------- |
| `↑/↓` or `K/J` | Navigate                        |
| `Enter/Space`  | Toggle local extension          |
| `S`            | Save changes                    |
| `A`            | Package actions (update/remove) |
| `R`            | Browse remote packages          |
| `?` / `H`      | Help                            |
| `Esc`          | Cancel / Exit                   |

## 🏗️ Extension Discovery

pi-extmgr discovers extensions from multiple sources:

### Local Extensions

```
~/.pi/agent/extensions/              # Global
├── my-extension.ts
├── disabled-extension.ts.disabled
└── my-extension/
    └── index.ts

./.pi/extensions/                    # Project
├── project-tool.ts
└── local-helper/
    └── index.ts
```

### Installed Packages

Managed by `pi install`:

- npm packages (`npm:package@version`)
- git packages (`git:https://...`)
- Stored in pi's package cache

**Naming**: Append `.disabled` to disable a local extension without removing it.

## 🔧 Configuration

No configuration needed! But you can customize your Pi theme to change the appearance:

```typescript
// In your theme extension
export default function myTheme(pi: ExtensionAPI) {
  pi.registerTheme({
    name: "my-theme",
    colors: {
      accent: "#00ff00",
      success: "#00aa00",
      error: "#ff0000",
      warning: "#ffaa00",
      // ... other colors
    },
  });
}
```

## 📝 Example Workflows

### Managing All Extensions

1. Press `Ctrl+Shift+E` or type `/extensions`
2. See all local extensions and installed packages in one view
3. Navigate with `↑↓`
4. For local extensions: press `Space` to toggle on/off
5. For packages: press `A` for actions (update/remove)
6. Press `S` to save any changes to local extensions
7. Confirm reload to apply changes

### Installing a New Extension

1. Type `/extensions` to open manager
2. Press `R` for remote packages
3. Browse or search for the extension
4. Press `Enter` on the desired package
5. Choose install mode:
   - **"Install via npm (managed)"** - Uses pi's package manager. Auto-updates with `pi update`. Best for most users.
   - **"Install locally (standalone)"** - Copies entire package to `~/.pi/agent/extensions/{package}/`. Supports multi-file extensions with imports. Manual updates required.
6. Confirm installation
7. Choose to reload Pi to activate

**Local Install Directory Structure:**

```
~/.pi/agent/extensions/
└── pi-some-extension/          # Full package directory
    ├── index.ts               # Entry point
    ├── utils.ts               # Helper (imports work!)
    └── package.json           # Original package.json preserved
```

### Updating a Package

1. Type `/extensions` to open unified manager
2. Navigate to the installed package
3. Press `A` for actions
4. Select "Update package"
5. Confirm reload if updated

### Disabling a Local Extension Temporarily

1. Type `/extensions` to open manager
2. Navigate to the local extension with `↑↓`
3. Press `Space` to toggle it off
4. Press `S` to save
5. Confirm reload

The extension remains installed but won't load until re-enabled.

### Removing a Package

1. Type `/extensions` to open unified manager
2. Navigate to the installed package with `↑↓`
3. Press `A` for actions
4. Select "Remove package"
5. Confirm removal

**Important**: Unlike install/update, removing a package requires a **full restart** of pi (not just `/reload`). The extension files are deleted, but the extension remains loaded in memory until you exit and restart pi.

### Updating All Packages

1. Type `/extensions` to open unified manager
2. Navigate to any installed package
3. Press `A` for actions
4. Select "Update package"
5. Or use command: `/extensions install npm:pi-extmgr` then select "[Update all packages]"

## 🐛 Troubleshooting

### Commands not showing after install

Make sure to reload Pi:

```
/reload
```

### Extension not appearing in list

Check that the file has a `.ts` or `.js` extension and is in one of the discovery paths:

- `~/.pi/agent/extensions/` (global)
- `.pi/extensions/` (project)

### Package installation fails

- Check npm is installed and accessible
- For git installs, ensure git is available
- Verify the package has the `pi-package` keyword for browsing

### Commands still work after removing package

This is expected behavior. When you remove a package:

1. The files are deleted from disk
2. The extension remains loaded in pi's memory
3. Commands continue to work until you **restart pi**\n
   A full restart (Ctrl+C or `/quit`) is required to fully unload removed extensions. `/reload` is only sufficient for install/update operations.

### Back to manager closes everything

Fixed! Pressing "Back to manager" now correctly returns to the unified view instead of closing.

## 🤝 Contributing

Contributions welcome! Please ensure:

1. Run `pnpm run check` before committing
2. Husky pre-commit hooks will validate automatically
3. Follow existing code style

```bash
# Setup
git clone https://github.com/ayagmar/pi-extmgr.git
cd pi-extmgr
pnpm install

# Development
pnpm run typecheck  # Type checking
pnpm run lint       # Linting
pnpm run check      # Full validation

# Test in Pi
pi install ./index.ts
/reload
```

## 📄 License

MIT © [ayagmar](https://github.com/ayagmar)

---

<p align="center">
  Made with ❤️ for the Pi community
</p>
