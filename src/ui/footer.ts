/**
 * Footer component for the unified extension manager UI
 */
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Container, Text, Spacer } from "@mariozechner/pi-tui";
import type { UnifiedItem, State } from "../types/index.js";

export interface FooterState {
  hasToggleRows: boolean;
  hasLocals: boolean;
  hasPackages: boolean;
  pendingChangeCount: number;
}

/**
 * Build the footer state from items and staged changes
 */
export function buildFooterState(
  items: UnifiedItem[],
  staged: Map<string, State>,
  byId: Map<string, UnifiedItem>
): FooterState {
  const hasLocals = items.some((i) => i.type === "local");
  const hasPackageExtensions = items.some((i) => i.type === "package-extension");
  const hasToggleRows = hasLocals || hasPackageExtensions;
  const hasPackages = items.some((i) => i.type === "package");

  const pendingChangeCount = getPendingToggleChangeCount(staged, byId);

  return {
    hasToggleRows,
    hasLocals,
    hasPackages,
    pendingChangeCount,
  };
}

export function getPendingToggleChangeCount(
  staged: Map<string, State>,
  byId: Map<string, UnifiedItem>
): number {
  let count = 0;
  for (const [id, state] of staged.entries()) {
    const item = byId.get(id);
    if (!item) continue;
    if (
      (item.type === "local" || item.type === "package-extension") &&
      item.originalState !== state
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * Build the keyboard shortcuts text for the footer
 */
export function buildFooterShortcuts(state: FooterState): string {
  const { hasToggleRows, hasPackages, pendingChangeCount } = state;
  const hasChanges = pendingChangeCount > 0;

  const parts: string[] = [];
  parts.push("↑↓ Navigate");
  if (hasToggleRows) parts.push("Space/Enter Toggle");
  if (hasToggleRows) parts.push(hasChanges ? "S Save*" : "S Save");
  if (hasPackages) parts.push("Enter/A Actions");
  if (hasPackages) parts.push("u Update");
  if (hasPackages || state.hasLocals) parts.push("X Remove");
  parts.push("i Install");
  parts.push("f Search");
  parts.push("U Update all");
  parts.push("t Auto-update");
  parts.push("P Palette");
  parts.push("R Browse");
  parts.push("? Help");
  parts.push("Esc Cancel");

  return parts.join(" | ");
}

/**
 * Create a footer container with the given theme
 */
export function createFooter(
  state: FooterState,
  theme: Theme
): { container: Container; invalidate: () => void } {
  const container = new Container();

  container.addChild(new Spacer(1));

  const shortcutsText = buildFooterShortcuts(state);
  const footerText = new Text(theme.fg("dim", shortcutsText), 2, 0);
  container.addChild(footerText);

  // DynamicBorder will be added by the caller

  return {
    container,
    invalidate: () => container.invalidate(),
  };
}
