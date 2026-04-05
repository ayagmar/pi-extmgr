/**
 * Help display
 */
import { type ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { notify } from "../utils/notify.js";

export function showHelp(ctx: ExtensionCommandContext): void {
  const lines = [
    "Extensions Manager Help",
    "",
    "Unified View:",
    "  Local extensions and npm/git packages are displayed together",
    "  The list is grouped into Local extensions and Installed packages sections",
    "  Rows stay compact; details for the selected item appear below the list",
    "  Local extensions show ● enabled / ○ disabled with G/P scope",
    "  Packages show a source-type icon with name@version, scope, and size when known",
    "",
    "Navigation:",
    "  ↑↓           Navigate list",
    "  PageUp/Down  Jump through longer lists",
    "  Home/End     Jump to top or bottom",
    "  Space        Toggle selected local extension enabled/disabled",
    "  S            Save changes to local extensions",
    "  Enter/A      Open actions for the selected item",
    "  / or Ctrl+F  Search visible items",
    "  Tab/Shift+Tab Cycle filters",
    "  1-5          Quick filters: All / Local / Packages / Updates / Disabled",
    "  c            Configure selected package extensions (reload after save)",
    "  u            Update selected package",
    "  V            View full details for the selected item",
    "  X            Remove selected item (package or local extension)",
    "  i            Quick install by source",
    "  f            Remote package search",
    "  U            Update all packages",
    "  t            Auto-update wizard",
    "  P/M          Quick actions palette",
    "  R            Browse remote packages",
    "  ?/H          Show this help",
    "  Esc          Clear search or cancel",
    "",
    "Extension Sources:",
    "  - ~/.pi/agent/extensions/ (global - G)",
    "  - .pi/extensions/ (project-local - P)",
    "  - npm packages installed via pi install",
    "  - git packages installed via pi install",
    "",
    "Commands:",
    "  /extensions              Open manager",
    "  /extensions list         List local extensions",
    "  /extensions installed    List installed packages (legacy)",
    "  /extensions remote       Browse community packages",
    "  /extensions search <q>   Search for packages",
    "  /extensions install <s> [--project|--global]  Install package (npm:, git:, or path)",
    "  /extensions remove <s>   Remove installed package",
    "  /extensions update [s]   Update package (or all packages)",
    "  /extensions history [o]  Show history (supports filters)",
    "    e.g. --failed --since 30m | --global --action package_update",
    "  /extensions auto-update  Show or change update schedule",
  ];

  notify(ctx, lines.join("\n"), "info");
}
