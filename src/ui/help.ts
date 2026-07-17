/**
 * Help display
 */
import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { notify } from "../utils/notify.js";

/** Keep help useful in a notification without repeating every footer hint. */
export function buildHelpLines(): string[] {
  return [
    "Extensions Manager Help",
    "",
    "Everyday controls",
    "  ↑↓ / PageUp/PageDown  Navigate",
    "  Space                Toggle local extension or select package",
    "  Enter                Open actions for the selected item",
    "  /                    Search visible items",
    "  Tab / Shift+Tab      Cycle filters",
    "  1-7                  All / Local / Packages / Updates / Disabled / Favorites / Recent",
    "  Esc                  Clear search, cancel, or leave",
    "",
    "Package actions",
    "  B                    Bulk actions for selected packages",
    "  c                    Configure package entrypoints",
    "  u / U                Update selected package / all packages",
    "  X                    Remove the selected package or local extension",
    "  V                    View details",
    "  E                    Expand package entrypoints when available",
    "",
    "Manager actions",
    "  S                    Save staged local-extension changes",
    "  i                    Install by source",
    "  f / R                Search / browse remote packages",
    "  W / L / D            Save / load / delete a manager view",
    "  *                    Toggle favorite",
    "  t                    Auto-update settings",
    "  P / M                Quick actions palette",
    "",
    "Sources and safety",
    "  G = global extension, P = project extension",
    "  Packages may be npm or git sources and show their scope inline",
    "  Missing compatibility, provenance, or checksum metadata is unknown",
    "  Changes that affect loaded extensions show Reload required",
    "",
    "Commands",
    "  /extensions profile list|save|apply|delete   Manage named profiles",
    "  /extensions trash list|restore|purge         Manage removed extensions",
    "  /extensions history [options]                Inspect package activity",
  ];
}

export function showHelp(ctx: ExtensionCommandContext): void {
  notify(ctx, buildHelpLines().join("\n"), "info");
}
