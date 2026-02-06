# 🔧 pi-extmgr

> Enhanced UI/UX for managing Pi extensions and discovering community packages

[![CI](https://github.com/ayagmar/pi-extmgr/actions/workflows/ci.yml/badge.svg)](https://github.com/ayagmar/pi-extmgr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**pi-extmgr** transforms extension management in Pi from a command-line chore into a delightful interactive experience. Browse, install, and manage extensions with an intuitive TUI interface, smart autocomplete, and one-click operations.

<!-- Replace with actual demo GIF/Screenshot when available -->
<!-- ![Demo](demo.gif) -->

## ✨ Features

### 🎨 Interactive TUI Interface

- **Beautiful themed interface** with color-coded status indicators
- **Keyboard-driven navigation** - fast and efficient
- **Real-time previews** with package descriptions
- **Context-aware help** - press `?` anywhere for shortcuts

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
- **Visual change indicators** (\*) show pending modifications
- **Bulk operations** - update all packages at once
- **Scope indicators**: Global (G) vs Project (P) extensions

### 🎯 Quality of Life

- **Tab autocomplete** for all subcommands
- **Status bar integration** - shows installed package count
- **Keyboard shortcut**: `Ctrl+Shift+E` opens extension manager
- **Non-interactive mode** - works in scripts and CI
- **Smart deduplication** - handles same package in multiple scopes

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
/extensions              # Open full interactive manager
```

#### Local Extensions Manager

Manage your local extensions with an interactive list:

| Key           | Action                  |
| ------------- | ----------------------- |
| `↑↓`          | Navigate extensions     |
| `Space/Enter` | Toggle enabled/disabled |
| `S`           | Save changes            |
| `I`           | View installed packages |
| `R`           | Browse remote packages  |
| `M`           | Return to command line  |
| `?`           | Show help               |
| `Esc`         | Cancel                  |

**Staged Changes**: Toggle extensions on/off without immediate effect. Press `S` to apply all changes at once. Pending changes show `*` next to the extension name.

#### Community Package Browser

Browse and install from npm:

| Key     | Action               |
| ------- | -------------------- |
| `↑↓`    | Navigate packages    |
| `Enter` | View package details |
| `N`     | Next page            |
| `P`     | Previous page        |
| `R`     | Refresh search       |
| `M`     | Back to menu         |
| `Esc`   | Cancel               |

### Command Reference

```bash
# Local Extension Management
/extensions list              # List local extensions (text output)
/extensions local             # Open interactive manager (default)

# Package Discovery
/extensions remote            # Browse community packages
/extensions packages          # Alias for remote
/extensions search <query>    # Search npm for packages

# Package Management
/extensions installed         # List installed packages with actions
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

### In Interactive Mode

- `↑/↓` or `K/J` - Navigate
- `Enter/Space` - Select/Toggle
- `S` - Save changes
- `I` - Installed packages
- `R` - Remote packages
- `M` - Main menu / Back
- `?` or `H` - Help
- `Esc` - Cancel/Back

## 🏗️ Extension Discovery

pi-extmgr discovers extensions from two locations:

### Global Extensions

```
~/.pi/agent/extensions/
├── my-extension.ts
├── disabled-extension.ts.disabled
└── my-extension/
    └── index.ts
```

### Project Extensions

```
./.pi/extensions/
├── project-tool.ts
└── local-helper/
    └── index.ts
```

**Naming**: Append `.disabled` to disable an extension without removing it.

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

### Installing a New Extension

1. Press `Ctrl+Shift+E` or type `/extensions`
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

### Disabling an Extension Temporarily

1. Type `/extensions` to open manager
2. Navigate to the extension with `↑↓`
3. Press `Space` to toggle it off
4. Press `S` to save
5. Confirm reload

The extension remains installed but won't load until re-enabled.

### Updating All Packages

1. Type `/extensions installed`
2. Select "[Update all packages]"
3. Wait for updates to complete
4. Reload Pi if updates were applied

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

### Same package showing twice in installed list

This can happen when `pi list` returns the same package in different formats (e.g., both `npm:package@1.0.0` and the full node_modules path). The extension now automatically deduplicates by package name.

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
