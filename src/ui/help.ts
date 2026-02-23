/**
 * Help display
 */
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

export function showHelp(ctx: ExtensionCommandContext): void {
  const lines = [
    "Extensions Manager Help",
    "",
    "Unified View:",
    "  Local extensions and npm/git packages are displayed together",
    "  Local extensions show ● enabled / ○ disabled with G/P scope",
    "  Packages show 📦 with name@version and G/P scope",
    "",
    "Navigation:",
    "  ↑↓           Navigate list",
    "  Space/Enter  Toggle local extension enabled/disabled",
    "  S            Save changes to local extensions",
    "  Enter/A      Open actions for selected package",
    "  c            Configure selected package extensions (restart required after save)",
    "  u            Update selected package",
    "  X            Remove selected item (package or local extension)",
    "  i            Quick install by source",
    "  f            Quick search",
    "  U            Update all packages",
    "  t            Auto-update wizard",
    "  P/M          Quick actions palette",
    "  R            Browse remote packages",
    "  ?/H          Show this help",
    "  Esc          Cancel",
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

  const output = lines.join("\n");
  if (ctx.hasUI) {
    ctx.ui.notify(output, "info");
  } else {
    console.log(output);
  }
}
