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
    "  u            Update selected package",
    "  X            Remove selected package",
    "  i            Quick install by source",
    "  f            Quick search",
    "  U            Update all packages",
    "  t            Auto-update wizard",
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
    "  /extensions install <s>  Install package (npm:, git:, or path)",
    "  /extensions remove <s>   Remove installed package",
    "  /extensions update [s]   Update package (or all packages)",
    "  /extensions auto-update  Show or change update schedule",
  ];

  const output = lines.join("\n");
  if (ctx.hasUI) {
    ctx.ui.notify(output, "info");
  } else {
    console.log(output);
  }
}
