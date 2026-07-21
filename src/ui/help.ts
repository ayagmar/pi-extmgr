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
    "Workspace navigation",
    "  Tab / Shift+Tab      Next / previous workspace screen",
    "",
    "Everyday controls",
    "  ↑↓ / PageUp/PageDown  Navigate",
    "  Space                Toggle local extension or select package",
    "  Enter                Open actions for the selected item",
    "  /                    Search visible items",
    "  1-4                  Filter: All / Local / Packages / Updates",
    "  5-7                  Filter: Disabled / Favorites / Recent",
    "  Esc                  Clear search, cancel, or leave",
    "",
    "Package actions",
    "  B                    Bulk actions for selected packages",
    "  c                    Configure package entrypoints",
    "  u / U                Update selected package / all packages",
    "  X                    Remove the selected package or local extension",
    "  V                    View full details and recent activity",
    "",
    "Manager actions",
    "  S                    Save staged local-extension changes",
    "  i                    Install by source",
    "  f / R                Search / browse remote packages",
    "  W / L / D            Save / load / delete a manager view",
    "  *                    Toggle favorite",
    "  t                    Scheduled update checks settings",
    "  P / M                Open workspace screens and actions",
    "                         Discover · Profiles · Health",
    "",
    "Sources and safety",
    "  Every row shows its kind, scope, and effective state inline",
    "  Packages may be npm, git, or local sources",
    "  Missing compatibility or artifact-integrity evidence is unknown",
    "  Changes that affect loaded extensions show Reload required",
    "",
    "Screens",
    "  Discover              Browse and inspect community npm packages",
    "  Profiles              Review and apply, export, or delete package sets",
    "  Health                Review conflicts, compatibility, reload, and trash",
    "                          f fixes safe issues (never removes packages)",
    "",
    "Commands",
    "  /extensions profile list|save|apply|delete   Manage named profiles",
    "  /extensions profile import <source>          Import/save a local or HTTPS profile",
    "  /extensions profile check <source> [--json|--strict] Validate and report drift",
    "  /extensions trash list|restore|purge         Manage removed extensions",
    "  /extensions history [options]                Inspect package activity",
  ];
}

export function showHelp(ctx: ExtensionCommandContext): void {
  notify(ctx, buildHelpLines().join("\n"), "info");
}
